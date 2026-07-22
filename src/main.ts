import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import { appProviders } from "./server/providers/registry.ts";
import { startServer, type TrackerServer } from "./server/index.ts";
import { initUpdater } from "./updates/updater.ts";

// A packaged app's stdout/stderr can be a dead pipe (parent process gone),
// making any console.* write throw EPIPE in the main process. Swallow those —
// losing a log line beats an uncaught-exception dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

// A Finder-launched app inherits launchd's bare PATH (/usr/bin:/bin:…), which
// is missing homebrew and every place agent CLIs actually live — and the
// adapters, the copilot wrapper, and availability checks all resolve binaries
// on PATH. Capture the user's login-shell PATH once at startup. Terminal
// launches already have it; the replace is a no-op there.
if (process.platform !== "win32") {
  try {
    const loginPath = execFileSync(process.env.SHELL ?? "/bin/zsh", ["-l", "-c", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (loginPath !== "") process.env.PATH = loginPath;
  } catch {
    // A wedged shell profile must not block app launch; PATH stays as-is.
  }
}

// One app instance = one orchestrator = one SQLite writer.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let server: TrackerServer | undefined;

/** Frameless holding card while the orchestrator boots — closed on main-window ready-to-show. */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 300,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    backgroundColor: "#0d0e10",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void splash.loadFile(path.join(app.getAppPath(), "src", "splash.html"));
  return splash;
}

function createWindow(apiBase: string, splash?: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    show: false,
    backgroundColor: "#0d0e10",
    webPreferences: {
      preload: path.join(app.getAppPath(), "src", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The right panel's Browser surface embeds pages in a <webview> so it
      // can offer real chrome (history, devtools, zoom, cache/cookie clears).
      webviewTag: true,
    },
  });

  // Every target=_blank link — the preview's localhost URL, the PR — opens
  // in the system browser (ticket 34: no embedded webview), never a bare
  // Electron child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    if (splash && !splash.isDestroyed()) splash.close();
    win.show();
  });

  void win.loadFile(path.join(app.getAppPath(), "build", "renderer", "index.html"), {
    query: { apiBase },
  });
  return win;
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Terminal drawer PTYs: keyed by id, killed when their window goes away.
// The shell survives drawer toggles — only an explicit kill (or window
// close) ends the session.
const ptys = new Map<number, pty.IPty>();
let nextPtyId = 1;

ipcMain.handle("term:spawn", (event, opts: { cols: number; rows: number }) => {
  const shellPath = process.env.SHELL ?? "/bin/zsh";
  const proc = pty.spawn(shellPath, ["-l"], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: os.homedir(),
    env: process.env as Record<string, string>,
  });
  const id = nextPtyId++;
  ptys.set(id, proc);
  const sender = event.sender;
  proc.onData((data) => {
    if (!sender.isDestroyed()) sender.send("term:data", { id, data });
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!sender.isDestroyed()) sender.send("term:exit", { id, exitCode });
  });
  sender.once("destroyed", () => {
    if (ptys.delete(id)) proc.kill();
  });
  return id;
});

ipcMain.on("term:input", (_event, { id, data }: { id: number; data: string }) => {
  ptys.get(id)?.write(data);
});

ipcMain.on("term:resize", (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
  ptys.get(id)?.resize(cols, rows);
});

ipcMain.on("term:kill", (_event, id: number) => {
  const proc = ptys.get(id);
  ptys.delete(id);
  proc?.kill();
});

// The Browser surface's <webview> session. Cookie/cache clears run in the
// main process because the webview element exposes no session API in the
// renderer. Persistent so logins survive app restarts, like a real browser.
export const BROWSER_PARTITION = "persist:rs-browser";

ipcMain.handle("browser:clear-cache", () => session.fromPartition(BROWSER_PARTITION).clearCache());
ipcMain.handle("browser:clear-cookies", () =>
  session.fromPartition(BROWSER_PARTITION).clearStorageData({ storages: ["cookies"] }),
);

// Popups from embedded pages go to the system browser, same policy as the
// main window's target=_blank links.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
  }
});

// Home's add-project flow picks a local repo natively; null = user cancelled.
ipcMain.handle("tracker:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open a repository",
    buttonLabel: "Open",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

/**
 * One-time storage migration for the unsigned → Developer ID transition
 * (v0.2.6). The old adhoc-signed builds created the "Tracker Safe Storage"
 * keychain item, and its ACL is bound to that signature — so the signed app
 * touching it (safeStorage.isEncryptionAvailable at boot) makes macOS throw
 * a "wants to use your confidential information" password prompt, which
 * reads as malware to users. Deleting the item needs no prompt (ACLs guard
 * reading, not deleting); Electron mints a fresh item owned by this
 * signature on next use. The old token ciphertext dies with the key, so the
 * auth row is cleared too — the app simply shows signed-out and the user
 * reconnects GitHub in-app.
 */
const STORAGE_GENERATION = 2;
function migrateSafeStorageGeneration(): void {
  if (process.platform !== "darwin") return;
  const userData = app.getPath("userData");
  const marker = path.join(userData, "storage-generation");
  try {
    if (readFileSync(marker, "utf8").trim() === String(STORAGE_GENERATION)) return;
  } catch {
    // No marker: pre-generation install (or fresh — deletions below no-op).
  }
  try {
    execFileSync("security", ["delete-generic-password", "-s", "Tracker Safe Storage"], {
      stdio: "ignore",
    });
  } catch {
    // Item absent — fresh install or already migrated by hand.
  }
  try {
    const db = new DatabaseSync(path.join(userData, "tracker.db"));
    db.exec("DELETE FROM auth_account");
    db.close();
  } catch {
    // No DB or no auth table yet — nothing stored under the old key.
  }
  mkdirSync(userData, { recursive: true });
  writeFileSync(marker, String(STORAGE_GENERATION));
}

void app
  .whenReady()
  .then(async () => {
    migrateSafeStorageGeneration();
    const splash = createSplash();
    const boot = (port: number) =>
      startServer({
        dataDir: app.getPath("userData"),
        port,
        // Claude Code is a real adapter (ticket 38); Kiro and Copilot stay
        // scripted until their own slices. Built against the live provider
        // config so a settings edit lands on the next claim.
        providers: appProviders,
        // Keychain-backed token encryption (ADR-0006); the plaintext-fallback
        // cipher only ever applies if OS crypto is unavailable at boot.
        secrets: safeStorage.isEncryptionAvailable()
          ? {
              available: true,
              encrypt: (plaintext: string) => new Uint8Array(safeStorage.encryptString(plaintext)),
              decrypt: (ciphertext: Uint8Array) =>
                safeStorage.decryptString(Buffer.from(ciphertext)),
            }
          : undefined,
      });
    try {
      server = await boot(Number(process.env.TRACKER_PORT ?? 4400));
    } catch (error) {
      // The dev-api often holds 4400; the renderer learns the port via the
      // apiBase query param, so an ephemeral one works just as well.
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      server = await boot(0);
    }
    const apiBase = server.url;

    const win = createWindow(apiBase, splash);
    initUpdater(win, { closeServer: () => server?.close() });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(apiBase);
    });
  })
  .catch((error: unknown) => {
    dialog.showErrorBox("Tracker failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  });

app.on("before-quit", () => {
  void server?.close().catch(() => {});
  server = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

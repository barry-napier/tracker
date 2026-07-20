import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { demoProviders } from "./server/providers/demo.ts";
import { startServer, type TrackerServer } from "./server/index.ts";

// One app instance = one orchestrator = one SQLite writer.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let server: TrackerServer | undefined;

function createWindow(apiBase: string): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: "#0d0e10",
    webPreferences: {
      preload: path.join(app.getAppPath(), "src", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Every target=_blank link — the preview's localhost URL, the PR — opens
  // in the system browser (ticket 34: no embedded webview), never a bare
  // Electron child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(path.join(app.getAppPath(), "build", "renderer", "index.html"), {
    query: { apiBase },
  });
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
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

void app
  .whenReady()
  .then(async () => {
    const boot = (port: number) =>
      startServer({
        dataDir: app.getPath("userData"),
        port,
        // Scripted demo phases until the real adapter slices land.
        providers: demoProviders(),
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

    createWindow(apiBase);

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

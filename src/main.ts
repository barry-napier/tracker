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

// Home's clone flow picks the parent folder natively; null = user cancelled.
ipcMain.handle("tracker:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Clone into…",
    buttonLabel: "Clone here",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

void app.whenReady().then(async () => {
  server = await startServer({
    dataDir: app.getPath("userData"),
    port: Number(process.env.TRACKER_PORT ?? 4400),
    // Scripted demo phases until the real adapter slices land.
    providers: demoProviders(),
  });
  const apiBase = server.url;

  createWindow(apiBase);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(apiBase);
  });
});

app.on("before-quit", () => {
  void server?.close().catch(() => {});
  server = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

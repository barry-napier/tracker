import { app, BrowserWindow } from "electron";
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

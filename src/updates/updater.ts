import { app, ipcMain, type BrowserWindow } from "electron";
// electron-updater is CJS; default-import and destructure for NodeNext ESM.
import electronUpdater from "electron-updater";
import {
  initialState,
  onAvailable,
  onCheckError,
  onCheckStart,
  onDownloaded,
  onDownloadError,
  onDownloadProgress,
  onDownloadStart,
  onUpToDate,
  type UpdateState,
} from "./updateState.ts";

const { autoUpdater } = electronUpdater;

// T3's cadence: first check shortly after boot, then a slow poll. Download
// and install stay user-initiated — nothing happens behind the pill.
const STARTUP_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60_000;

export interface UpdaterOptions {
  /** Stops the embedded Hono server before quitAndInstall. */
  closeServer: () => Promise<void> | void;
}

export function initUpdater(win: BrowserWindow, options: UpdaterOptions): void {
  // Dev builds run from the repo, not a signed bundle — updating is meaningless
  // there. IPC handlers still register so the renderer sees "disabled".
  const enabled = app.isPackaged && !process.env.TRACKER_DISABLE_UPDATES;
  let state: UpdateState = initialState(app.getVersion(), enabled);

  const setState = (next: UpdateState): void => {
    state = next;
    if (!win.isDestroyed()) win.webContents.send("update:state", state);
  };

  ipcMain.handle("update:get-state", () => state);

  if (!enabled) {
    ipcMain.handle("update:check", () => state);
    ipcMain.handle("update:download", () => state);
    ipcMain.handle("update:install", () => state);
    return;
  }

  // Default logger is `console`; in a packaged app with a dead stdout pipe
  // those writes throw EPIPE and crash the main process (seen from
  // MacUpdater.doCheckForUpdates → console.info). State flows via IPC anyway.
  autoUpdater.logger = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => setState(onCheckStart(state)));
  autoUpdater.on("update-not-available", () => setState(onUpToDate(state)));
  autoUpdater.on("update-available", (info) => setState(onAvailable(state, info.version)));
  autoUpdater.on("download-progress", (progress) =>
    setState(onDownloadProgress(state, Math.round(progress.percent))),
  );
  autoUpdater.on("update-downloaded", (info) => setState(onDownloaded(state, info.version)));
  autoUpdater.on("error", (error) => {
    const message = error.message || String(error);
    setState(
      state.status === "downloading" ? onDownloadError(state, message) : onCheckError(state, message),
    );
  });

  const check = (): void => {
    // Skip while a download is in flight or an install is pending.
    if (state.status === "downloading" || state.status === "downloaded") return;
    autoUpdater.checkForUpdates().catch(() => {
      // Failures also arrive via the "error" event; this just silences the
      // unhandled rejection.
    });
  };

  ipcMain.handle("update:check", () => {
    check();
    return state;
  });

  ipcMain.handle("update:download", () => {
    if (state.status === "available") {
      setState(onDownloadStart(state));
      autoUpdater.downloadUpdate().catch(() => {});
    }
    return state;
  });

  ipcMain.handle("update:install", async () => {
    if (state.status !== "downloaded") return state;
    try {
      await options.closeServer();
    } catch {
      // A stuck server shouldn't block the update; quit tears it down anyway.
    }
    autoUpdater.quitAndInstall();
    return state;
  });

  const startupTimer = setTimeout(check, STARTUP_DELAY_MS);
  const pollTimer = setInterval(check, POLL_INTERVAL_MS);
  app.on("before-quit", () => {
    clearTimeout(startupTimer);
    clearInterval(pollTimer);
  });
}

// Pure update-state machine — no Electron imports, so it's unit-testable.
// Adapted from T3 Code's updateMachine.ts, minus channels/release-notes.

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  /** 0–100 while downloading, 100 once downloaded. */
  downloadPercent: number | null;
  /** Error text when status is "error" or a retryable download failure. */
  message: string | null;
  errorContext: "check" | "download" | null;
  canRetry: boolean;
}

export function initialState(currentVersion: string, enabled: boolean): UpdateState {
  return {
    status: enabled ? "idle" : "disabled",
    currentVersion,
    availableVersion: null,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onCheckStart(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "checking",
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onUpToDate(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onAvailable(state: UpdateState, version: string): UpdateState {
  return {
    ...state,
    status: "available",
    availableVersion: version,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onCheckError(state: UpdateState, message: string): UpdateState {
  return {
    ...state,
    status: "error",
    message,
    downloadPercent: null,
    errorContext: "check",
    canRetry: true,
  };
}

export function onDownloadStart(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onDownloadProgress(state: UpdateState, percent: number): UpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function onDownloaded(state: UpdateState, version: string): UpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

// A failed download falls back to "available" (retryable) as long as we still
// know which version is out there — T3's nextStatusAfterDownloadFailure.
export function onDownloadError(state: UpdateState, message: string): UpdateState {
  const stillAvailable = state.availableVersion !== null;
  return {
    ...state,
    status: stillAvailable ? "available" : "error",
    message,
    downloadPercent: null,
    errorContext: "download",
    canRetry: stillAvailable,
  };
}

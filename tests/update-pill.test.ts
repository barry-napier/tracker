import { describe, expect, it } from "vitest";
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
} from "../src/updates/updateState.ts";
import { pillAction, pillLabel, shouldShowPill } from "../src/renderer/updatePill.ts";

const idle = initialState("0.2.0", true);
const available = onAvailable(idle, "0.3.0");

describe("updatePill", () => {
  it("hides for quiet states", () => {
    expect(shouldShowPill(null)).toBe(false);
    expect(shouldShowPill(initialState("0.2.0", false))).toBe(false);
    expect(shouldShowPill(idle)).toBe(false);
    expect(shouldShowPill(onCheckStart(idle))).toBe(false);
    expect(shouldShowPill(onUpToDate(idle))).toBe(false);
  });

  it("hides check errors — the poll will retry on its own", () => {
    expect(shouldShowPill(onCheckError(idle, "offline"))).toBe(false);
  });

  it("offers download when an update is available", () => {
    expect(shouldShowPill(available)).toBe(true);
    expect(pillLabel(available)).toBe("Update v0.3.0");
    expect(pillAction(available)).toBe("download");
  });

  it("shows progress while downloading, with no action", () => {
    const s = onDownloadProgress(onDownloadStart(available), 42);
    expect(pillLabel(s)).toBe("Downloading 42%");
    expect(pillAction(s)).toBe("none");
  });

  it("offers install once downloaded", () => {
    const s = onDownloaded(available, "0.3.0");
    expect(pillLabel(s)).toBe("Restart to update");
    expect(pillAction(s)).toBe("install");
  });

  it("offers retry after a download failure", () => {
    const s = onDownloadError(onDownloadStart(available), "disk full");
    expect(shouldShowPill(s)).toBe(true);
    expect(pillLabel(s)).toBe("Update failed — retry");
    expect(pillAction(s)).toBe("retry");
  });
});

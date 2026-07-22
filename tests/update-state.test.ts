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

describe("updateState", () => {
  it("starts disabled when updates are off (dev builds)", () => {
    expect(initialState("0.2.0", false).status).toBe("disabled");
    expect(initialState("0.2.0", true).status).toBe("idle");
  });

  it("walks the happy path: check → available → download → downloaded", () => {
    let s = initialState("0.2.0", true);
    s = onCheckStart(s);
    expect(s.status).toBe("checking");
    s = onAvailable(s, "0.3.0");
    expect(s.status).toBe("available");
    expect(s.availableVersion).toBe("0.3.0");
    s = onDownloadStart(s);
    expect(s.downloadPercent).toBe(0);
    s = onDownloadProgress(s, 42);
    expect(s.status).toBe("downloading");
    expect(s.downloadPercent).toBe(42);
    s = onDownloaded(s, "0.3.0");
    expect(s.status).toBe("downloaded");
    expect(s.downloadPercent).toBe(100);
  });

  it("resolves to up-to-date and clears any stale availableVersion", () => {
    let s = onAvailable(initialState("0.2.0", true), "0.3.0");
    s = onUpToDate(onCheckStart(s));
    expect(s.status).toBe("up-to-date");
    expect(s.availableVersion).toBeNull();
  });

  it("marks check failures as retryable errors", () => {
    const s = onCheckError(onCheckStart(initialState("0.2.0", true)), "network down");
    expect(s.status).toBe("error");
    expect(s.errorContext).toBe("check");
    expect(s.canRetry).toBe(true);
  });

  it("keeps availableVersion and retryability on download failure", () => {
    let s = onAvailable(initialState("0.2.0", true), "0.3.0");
    s = onDownloadError(onDownloadStart(s), "disk full");
    expect(s.status).toBe("available");
    expect(s.availableVersion).toBe("0.3.0");
    expect(s.errorContext).toBe("download");
    expect(s.canRetry).toBe(true);
    expect(s.message).toBe("disk full");
  });

  it("falls to error on download failure with no known version", () => {
    const s = onDownloadError(initialState("0.2.0", true), "weird");
    expect(s.status).toBe("error");
    expect(s.canRetry).toBe(false);
  });

  it("clears the failure message when a retry starts", () => {
    let s = onAvailable(initialState("0.2.0", true), "0.3.0");
    s = onDownloadError(onDownloadStart(s), "disk full");
    s = onDownloadStart(s);
    expect(s.message).toBeNull();
    expect(s.errorContext).toBeNull();
  });
});

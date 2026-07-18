import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readCheckManifest } from "../src/server/checks.ts";
import type { AcceptanceCriterion } from "../src/server/types.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function worktree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tracker-checks-"));
  dirs.push(dir);
  return dir;
}

function ac(id: number, status: AcceptanceCriterion["status"] = "pending"): AcceptanceCriterion {
  return {
    id,
    ticketId: 1,
    text: `criterion ${id}`,
    position: id,
    status,
    origin: "original",
    provenance: null,
    waiveReason: null,
    check: null,
    createdAt: "",
    updatedAt: "",
  };
}

function writeManifest(cwd: string, manifest: unknown): void {
  mkdirSync(path.join(cwd, "checks"), { recursive: true });
  writeFileSync(path.join(cwd, "checks", "manifest.json"), JSON.stringify(manifest));
}

function writeScript(cwd: string, name: string): void {
  mkdirSync(path.join(cwd, "checks"), { recursive: true });
  writeFileSync(path.join(cwd, "checks", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("readCheckManifest", () => {
  test("maps every pending AC to a script or a human routing", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeManifest(cwd, { "1": "checks/ac-1.sh", "2": { human: "needs visual judgment" } });

    const result = readCheckManifest(cwd, [ac(1), ac(2)]);
    expect(result).toEqual({
      ok: true,
      entries: [
        { acId: 1, kind: "script", scriptPath: "checks/ac-1.sh" },
        { acId: 2, kind: "human", reason: "needs visual judgment" },
      ],
    });
  });

  test("fails when the manifest is missing", () => {
    const result = readCheckManifest(worktree(), [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("checks/manifest.json");
  });

  test("fails when the manifest is not valid JSON", () => {
    const cwd = worktree();
    mkdirSync(path.join(cwd, "checks"), { recursive: true });
    writeFileSync(path.join(cwd, "checks", "manifest.json"), "not json");
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("JSON");
  });

  test("fails when a pending AC is not covered, naming it", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeManifest(cwd, { "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1), ac(2)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("AC-2");
  });

  test("fails when a script entry points at a file that does not exist", () => {
    const cwd = worktree();
    writeManifest(cwd, { "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("checks/ac-1.sh");
  });

  test("fails when a script path escapes the worktree", () => {
    const cwd = worktree();
    writeManifest(cwd, { "1": "../outside.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("outside");
  });

  test("fails when a human routing has no reason", () => {
    const cwd = worktree();
    writeManifest(cwd, { "1": { human: "  " } });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("reason");
  });

  test("fails when a check script is not executable", () => {
    const cwd = worktree();
    mkdirSync(path.join(cwd, "checks"), { recursive: true });
    writeFileSync(path.join(cwd, "checks", "ac-1.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    writeManifest(cwd, { "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("not executable");
  });

  test("fails when a script entry points at a directory", () => {
    const cwd = worktree();
    mkdirSync(path.join(cwd, "checks", "ac-1.sh"), { recursive: true });
    writeManifest(cwd, { "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("checks/ac-1.sh");
  });

  test("fails on a non-canonical AC id key — no silent aliasing", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeManifest(cwd, { "01": "checks/ac-1.sh", "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain('"01"');
  });

  test("fails on a key that matches no AC of the ticket", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeManifest(cwd, { "1": "checks/ac-1.sh", "99": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1)]);
    expect(result).toMatchObject({ ok: false });
    expect((result as any).failure).toContain("99");
  });

  test("tolerates entries for non-pending ACs but registers only pending ones", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeScript(cwd, "ac-2.sh");
    // AC 2 was verified by a human between runs; its stale entry stays valid.
    writeManifest(cwd, { "1": "checks/ac-1.sh", "2": "checks/ac-2.sh" });
    const result = readCheckManifest(cwd, [ac(1), ac(2, "verified")]);
    expect(result).toEqual({
      ok: true,
      entries: [{ acId: 1, kind: "script", scriptPath: "checks/ac-1.sh" }],
    });
  });

  test("waived ACs need no coverage", () => {
    const cwd = worktree();
    writeScript(cwd, "ac-1.sh");
    writeManifest(cwd, { "1": "checks/ac-1.sh" });
    const result = readCheckManifest(cwd, [ac(1), ac(2, "waived")]);
    expect(result).toEqual({
      ok: true,
      entries: [{ acId: 1, kind: "script", scriptPath: "checks/ac-1.sh" }],
    });
  });
});

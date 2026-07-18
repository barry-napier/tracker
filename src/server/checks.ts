import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AcceptanceCriterion } from "./types.ts";

/** One manifest entry, resolved against an AC row: how that AC gets verified. */
export type CheckRegistration =
  | { acId: number; kind: "script"; scriptPath: string }
  | { acId: number; kind: "human"; reason: string };

export type ManifestResult =
  | { ok: true; entries: CheckRegistration[] }
  | { ok: false; failure: string };

const MANIFEST_PATH = path.join("checks", "manifest.json");

/**
 * The plan phase's extended Phase Contract (ticket 07 §4): checks/manifest.json
 * maps every pending AC id to a script path (exit 0 = verified) or to
 * `{"human": "<reason>"}` routing it to the Manual Walkthrough. Entries for
 * ACs no longer pending are tolerated — a bounced Run's manifest legitimately
 * still names them — but only pending ACs are registered. Anything else
 * (missing coverage, dangling script, unknown AC id) fails the phase.
 */
export function readCheckManifest(
  worktreePath: string,
  acs: readonly AcceptanceCriterion[],
): ManifestResult {
  const file = path.join(worktreePath, MANIFEST_PATH);
  if (!existsSync(file)) {
    return fail(`${MANIFEST_PATH} missing — the plan phase must map every pending AC`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fail(`${MANIFEST_PATH} is not valid JSON`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return fail(`${MANIFEST_PATH} must be an object mapping AC ids to entries`);
  }

  const byId = new Map(acs.map((ac) => [ac.id, ac]));
  const entries: CheckRegistration[] = [];
  for (const [key, value] of Object.entries(manifest)) {
    // Canonical ids only: "01" aliasing "1" would silently double-register.
    const acId = /^[1-9]\d*$/.test(key) ? Number(key) : undefined;
    const ac = acId === undefined ? undefined : byId.get(acId);
    if (!ac) return fail(`${MANIFEST_PATH} names "${key}", which is no AC of this ticket`);

    let entry: CheckRegistration;
    if (typeof value === "string") {
      const resolved = path.resolve(worktreePath, value);
      if (path.isAbsolute(value) || !resolved.startsWith(worktreePath + path.sep)) {
        return fail(`check script for AC-${ac.id} points outside the worktree: ${value}`);
      }
      const stat = existsSync(resolved) ? statSync(resolved) : undefined;
      if (!stat?.isFile()) {
        return fail(`check script for AC-${ac.id} does not exist: ${value}`);
      }
      // Spec (ticket 07 §4) says executable; fail here, not at the battery.
      if ((stat.mode & 0o111) === 0) {
        return fail(`check script for AC-${ac.id} is not executable: ${value}`);
      }
      entry = { acId: ac.id, kind: "script", scriptPath: value };
    } else if (isHumanRouting(value)) {
      if (value.human.trim() === "") {
        return fail(`human routing for AC-${ac.id} needs a one-line reason`);
      }
      entry = { acId: ac.id, kind: "human", reason: value.human.trim() };
    } else {
      return fail(
        `entry for AC-${ac.id} must be a script path or {"human": "<reason>"}`,
      );
    }
    if (ac.status === "pending") entries.push(entry);
  }

  const uncovered = acs.filter(
    (ac) => ac.status === "pending" && !entries.some((entry) => entry.acId === ac.id),
  );
  if (uncovered.length > 0) {
    return fail(
      `${MANIFEST_PATH} does not cover pending ${uncovered
        .map((ac) => `AC-${ac.id}`)
        .join(", ")}`,
    );
  }
  return { ok: true, entries };
}

function isHumanRouting(value: unknown): value is { human: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { human?: unknown }).human === "string"
  );
}

function fail(failure: string): ManifestResult {
  return { ok: false, failure };
}

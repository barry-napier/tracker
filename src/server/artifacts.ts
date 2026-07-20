import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import { git } from "./worktrees.ts";

/**
 * Persists a Run's evidence out of its worktree into app data. Runs at the
 * end of every Run — pass, bounce, or crash — because a worktree is working
 * space, not storage: evidence must survive re-claims and sweeps. Blobs land
 * under `<data>/artifacts/run-<id>/`; the Store rows carry the content hash
 * and the worktree HEAD SHA at persist time.
 */
export class ArtifactStore {
  constructor(
    private readonly dataDir: string,
    private readonly store: Store,
  ) {}

  async persistRun(runId: number, worktreePath: string): Promise<void> {
    const kbDir = path.join(worktreePath, "kb");
    if (!existsSync(kbDir)) return;
    const names = readdirSync(kbDir).filter((name) =>
      statSync(path.join(kbDir, name)).isFile(),
    );
    if (names.length === 0) return;

    const worktreeHeadSha = await git(worktreePath, "rev-parse", "HEAD");
    const files = names.map((name) =>
      this.persistBlob(runId, "kb", name, readFileSync(path.join(kbDir, name))),
    );
    this.store.recordArtifacts(runId, worktreeHeadSha, files);
  }

  /**
   * Persist one worktree file after the run's own persist already happened —
   * how the Bounce Report (rendered post-battery) joins the bounced Run's
   * evidence.
   */
  async persistFile(
    runId: number,
    worktreePath: string,
    relativePath: string,
    kind: string,
  ): Promise<void> {
    const worktreeHeadSha = await git(worktreePath, "rev-parse", "HEAD");
    const content = readFileSync(path.join(worktreePath, relativePath));
    const file = this.persistBlob(runId, kind, path.basename(relativePath), content);
    this.store.recordArtifacts(runId, worktreeHeadSha, [file]);
  }

  /**
   * Persist evidence produced outside the worktree — the demo recorder's
   * video/transcript (ticket 35), whose bytes live under app data or only in
   * memory. The worktree still stamps the HEAD SHA: freshness gates compare
   * against the code the evidence was recorded at.
   */
  async persistContent(
    runId: number,
    worktreePath: string,
    kind: string,
    name: string,
    content: Buffer,
  ): Promise<void> {
    const worktreeHeadSha = await git(worktreePath, "rev-parse", "HEAD");
    const file = this.persistBlob(runId, kind, name, content);
    this.store.recordArtifacts(runId, worktreeHeadSha, [file]);
  }

  /**
   * kb/ files this store can't vouch for — no persisted artifact of the same
   * name and content across the given runs. The Done sweep's evidence guard
   * (ticket 42): anything listed would be destroyed unvouched, so it blocks
   * the reap. Flat like persistRun above — kb/ is a flat namespace by
   * construction, and the two must stay mirror images.
   */
  unvouchedKbFiles(runIds: readonly number[], worktreePath: string): string[] {
    const kbDir = path.join(worktreePath, "kb");
    if (!existsSync(kbDir)) return [];
    const vouched = new Set(
      runIds
        .flatMap((runId) => this.store.listArtifacts(runId))
        .map((artifact) => `${artifact.name}:${artifact.contentHash}`),
    );
    const missing: string[] = [];
    for (const name of readdirSync(kbDir)) {
      const file = path.join(kbDir, name);
      if (!statSync(file).isFile()) continue;
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (!vouched.has(`${name}:${hash}`)) missing.push(`kb/${name}`);
    }
    return missing;
  }

  /** Blob to disk under the run's artifact dir; returns the Store row input. */
  private persistBlob(
    runId: number,
    kind: string,
    name: string,
    content: Buffer,
  ): { kind: string; name: string; path: string; contentHash: string } {
    const relativeDir = path.join("artifacts", `run-${runId}`);
    mkdirSync(path.join(this.dataDir, relativeDir), { recursive: true });
    const relativePath = path.join(relativeDir, name);
    writeFileSync(path.join(this.dataDir, relativePath), content);
    return {
      kind,
      name,
      path: relativePath,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  }
}

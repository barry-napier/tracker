import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ArtifactStore } from "./artifacts.ts";
import { DEFAULT_READINESS_TIMEOUT_MS, type PreviewManager } from "./previews.ts";
import type { Store } from "./store.ts";
import type { PreviewKind, Repo, Run, TicketWithAcs } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Where the agent authors the per-ticket demo, by repo kind (ticket 04). */
export const UI_DEMO_SPEC = "demo/demo.spec.ts";
export const API_DEMO_SCRIPT = "demo/demo.sh";

/** The persisted demo artifact's kind — what the wizard's walkthrough finds. */
export const DEMO_ARTIFACT_KIND = "demo";

/** A demo that can't finish in this is a broken demo, not a slow one. */
const DEMO_TIMEOUT_MS = 5 * 60_000;
/** Full output lives in the transcript/log; failure reasons carry an excerpt. */
const REASON_EXCERPT_CHARS = 800;

/** Branch prefixes whose tickets aren't user-facing → no demo expected. */
const NON_USER_FACING_TYPES = new Set(["chore", "refactor", "docs", "test", "ci", "build"]);

/**
 * Whether a ticket owes a demo — the single source both the recorder and the
 * demo-fresh gate consult, so they can never disagree. Fact-driven only
 * (ticket type, repo config), never agent-declared.
 */
export function demoExpectation(
  ticket: Pick<TicketWithAcs, "branch">,
  repo: Pick<Repo, "previewCommand" | "previewKind">,
): { owed: true; kind: PreviewKind } | { owed: false; reason: string } {
  const type = ticket.branch?.split("/")[0] ?? "";
  if (NON_USER_FACING_TYPES.has(type)) {
    return { owed: false, reason: `ticket type "${type}" is not user-facing` };
  }
  if (repo.previewCommand === null) {
    return { owed: false, reason: "no preview configured — no demo expected" };
  }
  if (repo.previewKind === null) {
    return { owed: false, reason: "no preview kind configured — no recorder to choose" };
  }
  return { owed: true, kind: repo.previewKind };
}

/**
 * How the demo phase ended. Failed is an outcome the demo-fresh gate reports
 * honestly, never a crash — a broken preview boot or a red demo spec must
 * bounce the ticket, not strand the run.
 */
export type DemoOutcome =
  | { status: "recorded"; kind: PreviewKind; name: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface DemoContext {
  run: Run;
  ticket: TicketWithAcs;
  repo: Repo;
  worktreePath: string;
  signal?: AbortSignal;
}

/**
 * The demo phase (ticket 35, per the ticket-04 research): after the workflow
 * completes, boot the ticket's preview from its worktree and record the demo
 * against it — a Playwright run of the agent-authored `demo/demo.spec.ts`
 * with `recordVideo` + `baseURL` for `ui` repos, the transcript of the
 * agent-authored `demo/demo.sh` for `api` repos. The artifact persists like
 * any run evidence; freshness is judged by the demo-fresh gate against the
 * worktree HEAD it was recorded at. The agent authors the demo, the
 * orchestrator executes it — a demo can never be self-reported.
 */
export class DemoRecorder {
  constructor(
    private readonly dataDir: string,
    private readonly store: Store,
    private readonly previews: PreviewManager,
    private readonly artifacts: ArtifactStore,
  ) {}

  async record(ctx: DemoContext): Promise<DemoOutcome> {
    const expectation = demoExpectation(ctx.ticket, ctx.repo);
    if (!expectation.owed) return { status: "skipped", reason: expectation.reason };
    // The asset check precedes the boot: a run that never authored a demo
    // fails fast without spinning up (and tearing down) a pointless process.
    const asset = expectation.kind === "ui" ? UI_DEMO_SPEC : API_DEMO_SCRIPT;
    if (!existsSync(path.join(ctx.worktreePath, asset))) {
      return { status: "failed", reason: `no agent-authored demo at ${asset}` };
    }

    // A fresh process (ticket 36 gave PreviewManager the shared boot-and-wait):
    // a boot failure IS the demo step's failure — honest, reason carried.
    const boot = await this.previews.bootReady(ctx.ticket.id, {
      timeoutMs: ctx.repo.previewReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      signal: ctx.signal,
      actor: "agent",
    });
    if (!boot.ready) return { status: "failed", reason: boot.reason };
    try {
      return expectation.kind === "ui"
        ? await this.#recordVideo(ctx, boot.port)
        : await this.#recordTranscript(ctx, boot.port);
    } finally {
      await this.previews.stop(ctx.ticket.id, { actor: "agent" });
    }
  }

  /**
   * `ui`: run the worktree's own Playwright (`npx --no-install` — a worktree
   * without it fails honestly instead of installing anything) against an
   * orchestrator-authored config, so `recordVideo` + `baseURL` are the
   * orchestrator's word, not the spec's. The video only flushes on context
   * close; the test runner closes contexts per test, so collect afterwards.
   */
  async #recordVideo(ctx: DemoContext, port: number): Promise<DemoOutcome> {
    const demoDir = path.join(this.dataDir, "demos", `run-${ctx.run.id}`);
    const outDir = path.join(demoDir, "out");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const configPath = path.join(demoDir, "playwright.config.mjs");
    writeFileSync(configPath, playwrightConfig(ctx.worktreePath, outDir, port));

    const command = `npx --no-install playwright test --config=${shellQuote(configPath)}`;
    const { exitCode, output } = await this.#run(ctx, "/bin/sh", ["-c", command], port);
    if (exitCode !== 0) {
      return { status: "failed", reason: `playwright exited ${exitCode}\n${excerpt(output)}` };
    }
    const video = newestVideo(outDir);
    if (video === undefined) {
      return { status: "failed", reason: "playwright passed but recorded no video" };
    }
    await this.artifacts.persistContent(
      ctx.run.id,
      ctx.worktreePath,
      DEMO_ARTIFACT_KIND,
      "demo.webm",
      readFileSync(video),
    );
    return { status: "recorded", kind: "ui", name: "demo.webm" };
  }

  /** `api`: the script's combined output IS the demo artifact (ticket 04). */
  async #recordTranscript(ctx: DemoContext, port: number): Promise<DemoOutcome> {
    const script = path.join(ctx.worktreePath, API_DEMO_SCRIPT);
    const { exitCode, output } = await this.#run(ctx, "/bin/sh", [script], port);
    if (exitCode !== 0) {
      return { status: "failed", reason: `${API_DEMO_SCRIPT} exited ${exitCode}\n${excerpt(output)}` };
    }
    const transcript = `$ sh ${API_DEMO_SCRIPT}  # BASE_URL=http://localhost:${port}\n${output}`;
    await this.artifacts.persistContent(
      ctx.run.id,
      ctx.worktreePath,
      DEMO_ARTIFACT_KIND,
      "curl-transcript.txt",
      Buffer.from(transcript),
    );
    return { status: "recorded", kind: "api", name: "curl-transcript.txt" };
  }

  async #run(
    ctx: DemoContext,
    file: string,
    args: string[],
    port: number,
  ): Promise<{ exitCode: number; output: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: ctx.worktreePath,
        env: { ...process.env, PORT: String(port), BASE_URL: `http://localhost:${port}` },
        timeout: DEMO_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        signal: ctx.signal,
      });
      return { exitCode: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      const captured = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      return {
        // A timeout, abort, or spawn failure has no exit code; -1 marks it.
        exitCode: typeof failure.code === "number" ? failure.code : -1,
        output: captured === "" ? messageOf(error) : captured,
      };
    }
  }
}

function playwrightConfig(worktreePath: string, outDir: string, port: number): string {
  return [
    "// Generated by the tracker orchestrator for the demo phase (ticket 35).",
    "export default {",
    `  testDir: ${JSON.stringify(path.join(worktreePath, "demo"))},`,
    `  outputDir: ${JSON.stringify(outDir)},`,
    "  workers: 1,",
    "  retries: 0,",
    "  timeout: 120000,",
    '  reporter: [["line"]],',
    `  use: { baseURL: ${JSON.stringify(`http://localhost:${port}`)}, video: "on" },`,
    "};",
    "",
  ].join("\n");
}

/** Playwright names video files per test; the newest .webm is the demo. */
function newestVideo(dir: string): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".webm")) {
        const mtime = statSync(full).mtimeMs;
        if (newest === undefined || mtime > newest.mtime) newest = { file: full, mtime };
      }
    }
  };
  walk(dir);
  return newest?.file;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REASON_EXCERPT_CHARS ? trimmed : `…${trimmed.slice(-REASON_EXCERPT_CHARS)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

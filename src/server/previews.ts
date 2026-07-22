import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { NotFoundError, StateError, type Store } from "./store.ts";
import type { Actor, PreviewKind, PreviewRecord } from "./types.ts";

/** Readiness deadline when the repo doesn't override it (ticket 10); the
 * demo recorder waits out the same deadline. */
export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
/** How far past the deterministic preference the port probe walks. */
const PORT_PROBE_SPAN = 100;
const READINESS_POLL_MS = 100;
/** Cap on a single readiness probe: a server that accepts but never answers
 * must not pin the watcher past its deadline. */
const PROBE_TIMEOUT_MS = 2_000;
/** Grace between SIGTERM and SIGKILL on stop. */
const STOP_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 40;
/** How often bootReady re-reads the record while waiting for readiness. */
const BOOT_POLL_MS = 100;
/** Margin past the readiness deadline before bootReady gives up waiting. */
const BOOT_DEADLINE_MARGIN_MS = 10_000;

/**
 * A boot-and-wait outcome for the non-wizard consumers that need the bound
 * port synchronously — the demo recorder (ticket 35) and the dogfood phase
 * (ticket 36) — rather than the wizard's polling PreviewView.
 */
export type BootResult = { ready: true; port: number } | { ready: false; reason: string };

/** What the wizard's Manual Walkthrough step renders (ticket 34). */
export interface PreviewView {
  /** False when the repo has no preview command — the step stays degraded. */
  configured: boolean;
  kind: PreviewKind | null;
  command: string | null;
  record: PreviewRecord | null;
  /** The localhost link, only while the process is ready to serve. */
  url: string | null;
  /** The captured output's tail, only on failure — the wizard's log tail. */
  logTail: string | null;
}

interface LiveProcess {
  child: ChildProcess;
  /** Distinguishes this spawn from any later restart's. */
  generation: number;
  /** True once a deliberate stop owns the exit — the handler stands down. */
  stopping: boolean;
  /** Who started this process — its later transitions audit as the same actor. */
  actor: Actor;
}

/** Who drives a lifecycle call: the wizard's reviewer (default) or the
 * orchestrator's demo phase (ticket 35). */
interface LifecycleOpts {
  actor?: Actor;
}

/**
 * Owns the preview processes (ticket 34): spawn from the ticket's worktree
 * with the bound port injected as $PORT, watch readiness (TCP-open, or the
 * repo's HTTP path), and keep the per-Ticket record honest through every
 * transition. Two consumers by design (ticket 10): the wizard's Manual
 * Walkthrough and the orchestrator's demo phase (ticket 35). Processes are
 * in-memory only — the record is what survives.
 */
export class PreviewManager {
  #live = new Map<number, LiveProcess>();
  #generation = 0;

  constructor(
    private readonly dataDir: string,
    private readonly store: Store,
    /**
     * Base of the deterministic port preference (ticket 10: `base + n % 1000`,
     * probe up on conflict). Production leaves it at 4000; the test harness
     * offsets it per parallel worker so concurrent test files don't fight over
     * the same port band.
     */
    private readonly portBase = 4000,
  ) {}

  view(ticketId: number): PreviewView {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);
    const record = this.store.getPreview(ticketId) ?? null;
    return {
      configured: repo?.previewCommand != null,
      kind: repo?.previewKind ?? null,
      command: repo?.previewCommand ?? null,
      record,
      url: record?.status === "ready" && record.port !== null ? `http://localhost:${record.port}` : null,
      logTail: record?.status === "failed" ? this.#logTail(record) : null,
    };
  }

  /**
   * On-demand start (wizard open): a live process is left alone; anything
   * else — first use, a stopped verdict, a failure being retried — spawns
   * fresh. The deterministic port preference mirrors the prototype's
   * ticket-derived ports; the record stores what was actually bound.
   */
  async start(ticketId: number, opts: LifecycleOpts = {}): Promise<PreviewView> {
    const actor = opts.actor ?? "human";
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new NotFoundError(`ticket ${ticketId} not found`);
    const repo = ticket.repoId === null ? undefined : this.store.getRepo(ticket.repoId);
    if (!repo?.previewCommand) {
      throw new StateError(`repo for ${ticket.displayKey} has no preview configured`);
    }
    const run = this.store.listRuns(ticketId)[0];
    if (!run?.worktreePath) {
      throw new StateError(`ticket ${ticket.displayKey} has no worktree to preview`);
    }
    const current = this.#live.get(ticketId);
    if (current && current.child.exitCode === null && current.child.signalCode === null) {
      if (this.#isLiveStatus(ticketId)) return this.view(ticketId);
      // Record and process disagree (a raced transition): never spawn a
      // second process over a live one — take the survivor down first.
      current.stopping = true;
      await terminate(current.child);
      this.#live.delete(ticketId);
    }

    const port = await findFreePort(this.portBase + (ticket.number % 1000));
    const logRelative = path.join("previews", `ticket-${ticketId}.log`);
    mkdirSync(path.join(this.dataDir, "previews"), { recursive: true });
    const log = createWriteStream(path.join(this.dataDir, logRelative), { flags: "w" });

    // Detached → own process group, so stop can take the whole shell tree.
    const child = spawn("/bin/sh", ["-c", repo.previewCommand], {
      cwd: run.worktreePath,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);

    const generation = ++this.#generation;
    const live: LiveProcess = { child, generation, stopping: false, actor };
    this.#live.set(ticketId, live);
    this.store.upsertPreview(ticketId, { status: "starting", port, logPath: logRelative, actor });

    child.once("exit", (code, signal) => {
      log.end();
      if (this.#live.get(ticketId)?.generation !== generation) return;
      this.#live.delete(ticketId);
      // A deliberate stop owns its record transition; anything else is the
      // process dying under us — before or after ready, that's a failure.
      if (!live.stopping && this.#isLiveStatus(ticketId)) {
        this.store.upsertPreview(ticketId, {
          status: "failed",
          actor: live.actor,
          detail: { reason: `process exited (${signal ?? `code ${code}`})` },
        });
      }
    });

    void this.#watchReadiness(ticketId, live, port, repo.previewReadinessPath, timeoutMs(repo));
    return this.view(ticketId);
  }

  /** The wizard's restart action (and the demo phase's boot): always a fresh process. */
  async restart(ticketId: number, opts: LifecycleOpts = {}): Promise<PreviewView> {
    await this.stop(ticketId, opts);
    return this.start(ticketId, opts);
  }

  /**
   * Restart the preview and wait out its readiness verdict, returning the
   * bound port or an honest failure reason. Both orchestrator consumers boot
   * this way (a fresh process every time — never a survivor serving stale
   * code): the demo recorder after the workflow, and the dogfood phase inside
   * it. Readiness itself is watched by start's #watchReadiness; this just
   * polls the record it writes until a terminal state or the deadline.
   */
  async bootReady(
    ticketId: number,
    opts: { timeoutMs: number; signal?: AbortSignal; actor?: Actor },
  ): Promise<BootResult> {
    // Total by contract: a pre-readiness boot error (no free port, no
    // worktree) resolves to an honest reason, never a throw — so the dogfood
    // phase can still run and report "preview unavailable" instead of crashing.
    try {
      let current = await this.restart(ticketId, { actor: opts.actor });
      const deadline = Date.now() + opts.timeoutMs + BOOT_DEADLINE_MARGIN_MS;
      while (!opts.signal?.aborted) {
        const record = current.record;
        if (record?.status === "ready" && record.port !== null) {
          return { ready: true, port: record.port };
        }
        if (record?.status === "failed") {
          const tail = current.logTail === null ? "" : `\n${current.logTail}`;
          return { ready: false, reason: `preview boot failed${tail}` };
        }
        if (Date.now() > deadline) break;
        await sleep(BOOT_POLL_MS);
        current = this.view(ticketId);
      }
      await this.stop(ticketId, { actor: opts.actor });
      return {
        ready: false,
        reason: opts.signal?.aborted ? "preview boot aborted" : "preview boot never settled",
      };
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Clean stop (verdict submit, demo recorded, app quit): SIGTERM, grace, SIGKILL. */
  async stop(ticketId: number, opts: LifecycleOpts = {}): Promise<void> {
    const live = this.#live.get(ticketId);
    if (live) {
      live.stopping = true;
      await terminate(live.child);
      this.#live.delete(ticketId);
    }
    if (this.#isLiveStatus(ticketId)) {
      this.store.upsertPreview(ticketId, { status: "stopped", actor: opts.actor ?? "human" });
    }
  }

  /** App quit: every live preview goes down with the server. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((ticketId) => this.stop(ticketId)));
  }

  async #watchReadiness(
    ticketId: number,
    live: LiveProcess,
    port: number,
    readinessPath: string | null,
    deadlineMs: number,
  ): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (this.#live.get(ticketId) === live && !live.stopping) {
      if (await isReady(port, readinessPath)) {
        if (this.#live.get(ticketId) === live && !live.stopping) {
          this.store.upsertPreview(ticketId, { status: "ready", actor: live.actor });
        }
        return;
      }
      if (Date.now() > deadline) {
        // A restart may have superseded this spawn while isReady awaited.
        if (this.#live.get(ticketId) !== live) return;
        // Own the exit before killing so the exit handler stands down.
        live.stopping = true;
        await terminate(live.child);
        this.#live.delete(ticketId);
        this.store.upsertPreview(ticketId, {
          status: "failed",
          actor: live.actor,
          detail: { reason: `not ready within ${deadlineMs}ms` },
        });
        return;
      }
      await sleep(READINESS_POLL_MS);
    }
  }

  /** Whether the record still believes a process is (coming) up. */
  #isLiveStatus(ticketId: number): boolean {
    const status = this.store.getPreview(ticketId)?.status;
    return status === "starting" || status === "ready";
  }

  #logTail(record: PreviewRecord): string | null {
    if (record.logPath === null) return null;
    const file = path.join(this.dataDir, record.logPath);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n").trim();
  }
}

function timeoutMs(repo: { previewReadinessTimeoutMs: number | null }): number {
  return repo.previewReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
}

/** Deterministic-with-fallback (ticket 10): probe up from the preference. */
async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + PORT_PROBE_SPAN; port++) {
    if (await portFree(port)) return port;
  }
  throw new StateError(`no free port within ${PORT_PROBE_SPAN} of ${preferred}`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** TCP-open by default; the repo's HTTP path (2xx/3xx) when configured. */
async function isReady(port: number, readinessPath: string | null): Promise<boolean> {
  if (readinessPath === null) return tcpOpen(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${readinessPath}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1", timeout: PROBE_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** SIGTERM the process group, wait out the grace, then SIGKILL what's left. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // The shell died but its detached group may have survivors.
    killGroup(child, "SIGTERM");
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  killGroup(child, "SIGTERM");
  const timely = await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)]);
  if (!timely) {
    killGroup(child, "SIGKILL");
    await exited;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid = the detached process group: the shell and its children.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

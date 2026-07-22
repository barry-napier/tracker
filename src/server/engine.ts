import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BOUNCE_REPORT_PATH } from "./bounce.ts";
import { readCheckManifest } from "./checks.ts";
import {
  dogfoodTemplateVars,
  resolvePersona,
  type PreviewHandoff,
} from "./dogfood.ts";
import { evaluateSuite, lintArtifact } from "./gates.ts";
import { branchLabels, nextNode, nextNodeByLabel, triggerOf } from "./graph.ts";
import { DEFAULT_READINESS_TIMEOUT_MS, type PreviewManager } from "./previews.ts";
import type { ProviderRegistry, RunResult } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Store } from "./store.ts";
import { PHASE_GATE_PREFIX } from "./types.ts";
import type { DeathMode, Repo, Run, TicketWithAcs, WorkflowNode } from "./types.ts";

/** A phase died. The engine retries once; a second one crashes the Run. */
export class PhaseDeathError extends Error {
  constructor(
    readonly mode: DeathMode,
    reason: string,
  ) {
    super(`[${mode}] ${reason}`);
  }
}

/** The orchestrator cancelled the phase (app quit); nothing gets recorded. */
export class PhaseCancelledError extends Error {}

/**
 * The walk executed zero agent phases — a dead graph (e.g. a branching
 * trigger published before the validator forbade it), not weather. It is
 * deterministic: identical retries can never run a phase, so the worker
 * parks the ticket as "failed" instead of burning the crash cap, and the
 * gate battery never judges a run that did no work.
 */
export class DeadGraphError extends Error {}

/** Watchdog overrides (ticket 41); production runs on the defaults. */
export interface PhaseTimeouts {
  /** Kill a provider after this long with no output. Default 15 min. */
  silenceMs?: number;
  /** SIGTERM a phase outliving this wall clock. Default 30 min. */
  wallClockMs?: number;
}

const DEFAULT_SILENCE_MS = 15 * 60_000;
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

/**
 * In-phase verification (TRK-1): how many gate-failure re-prompts one phase
 * attempt gets on top of its first invocation. Exhaustion is a phase death
 * ("gate-exhausted"), which then rides the existing once-retry/crash policy —
 * worst case per phase: 2 attempts × (1 + 2 retries) = 6 provider invocations.
 */
export const PHASE_GATE_RETRIES = 2;


/** Everything a Run's phases execute against. */
export interface RunContext {
  run: Run;
  ticket: TicketWithAcs;
  repo: Repo;
  worktreePath: string;
  signal?: AbortSignal;
}

/**
 * The dumb interpreter (ADR-0001): start at the trigger, walk the single
 * unlabeled outgoing edge, run each agent phase in a fresh provider session.
 * A phase completes only when the provider signals success AND the Phase
 * Contract file `kb/<phase>.md` exists in the worktree.
 */
export class WorkflowEngine {
  readonly #silenceMs: number;
  readonly #wallClockMs: number;

  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly logs: RunLogRegistry,
    private readonly previews: PreviewManager,
    timeouts: PhaseTimeouts = {},
  ) {
    this.#silenceMs = timeouts.silenceMs ?? DEFAULT_SILENCE_MS;
    this.#wallClockMs = timeouts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  }

  /** Resolves on success; throws PhaseDeathError (run crashes) or PhaseCancelledError. */
  async execute(ctx: RunContext): Promise<void> {
    const provider = this.providers[ctx.ticket.provider!];
    if (!provider) throw new Error(`no adapter registered for provider ${ctx.ticket.provider}`);

    // The Run's pinned version (ADR-0004): the graph can never change under it.
    const workflow = this.store.getWorkflowGraph(ctx.run.workflowVersionId);
    // Context travels between phases as files: each completed phase's
    // contract doc joins the {{priorKb}} handoff for the ones after it.
    const priorKb: string[] = [];
    // Phase-level resume: a predecessor that died mid-run (app quit, crash)
    // left its completed phases' work in the reused worktree. Credit that
    // prefix — the contract file on disk is the proof — and start executing
    // at the first uncredited node instead of replaying the whole graph.
    let credit = this.store.priorPhaseCredit(ctx.run, ctx.worktreePath);
    // Walk from the trigger. A branch node (labeled outgoing edges) routes by
    // the phase's declared outcome; every other node follows its single
    // unlabeled edge, so a v1 linear graph runs exactly as before. Following
    // one edge per node means a fan-in target is reached — and runs — once.
    let node: WorkflowNode | undefined = nextNode(workflow, triggerOf(workflow));
    let phasesWalked = 0;
    while (node !== undefined) {
      if (node.type !== "agent_phase") {
        node = nextNode(workflow, node);
        continue;
      }
      phasesWalked += 1;
      const labels = branchLabels(workflow, node);
      let outcome: string | null;
      const resumed = credit.has(node.id)
        ? this.#tryResume(ctx, node, credit.get(node.id) ?? null)
        : undefined;
      if (resumed !== undefined) {
        outcome = resumed;
      } else {
        // Prefix only: once one phase re-runs, everything after it re-runs
        // too — later phases build on the one that just changed the tree.
        credit = new Map();
        try {
          outcome = await this.#runPhase(ctx, provider, node, priorKb, labels);
        } catch (error) {
          if (!(error instanceof PhaseDeathError)) throw error;
          // The crash policy's one retry (ticket 41): phases are idempotent,
          // and most deaths are weather. A second death ends the Run.
          outcome = await this.#runPhase(ctx, provider, node, priorKb, labels);
        }
      }
      priorKb.push(`kb/${node.name}.md`);
      node =
        outcome === null
          ? nextNode(workflow, node)
          : nextNodeByLabel(workflow, node, outcome);
    }
    if (phasesWalked === 0) {
      throw new DeadGraphError(
        `workflow "${workflow.name}" ran no agent phases — the walk from the trigger ` +
          `found no unlabeled edge to follow (a trigger cannot branch), so the run would ` +
          `reach the gate battery having done no work`,
      );
    }
  }

  /**
   * Credit one phase from the prior crashed Run instead of re-running it.
   * Returns the credited outcome (`null` for a non-branching node) when the
   * credit holds up against the worktree, or undefined when it doesn't —
   * the caller then executes the phase for real. The proof required: the
   * contract file is still on disk, and a check-emitting node's manifest
   * still covers every pending AC (statuses may have moved since the crash).
   */
  #tryResume(ctx: RunContext, node: WorkflowNode, outcome: string | null): string | null | undefined {
    if (!existsSync(path.join(ctx.worktreePath, "kb", `${node.name}.md`))) return undefined;
    if (node.emitsChecks) {
      const acs = this.store.getTicket(ctx.ticket.id)!.acceptanceCriteria;
      const manifest = readCheckManifest(ctx.worktreePath, acs);
      if (!manifest.ok) return undefined;
      this.store.registerAcChecks(ctx.run.id, manifest.entries);
    }
    this.store.recordResumedPhase(ctx.run.id, node, outcome);
    return outcome;
  }

  /**
   * Run one phase. Returns the edge label the phase routes on when its node
   * branches (`labels` non-empty), or null for a single-unlabeled-edge node.
   * Throws PhaseDeathError (any death mode) or PhaseCancelledError.
   */
  async #runPhase(
    ctx: RunContext,
    provider: NonNullable<ProviderRegistry[keyof ProviderRegistry]>,
    node: WorkflowNode,
    priorKb: readonly string[],
    labels: readonly string[],
  ): Promise<string | null> {
    const execution = this.store.startPhase(ctx.run.id, node);
    // The phase's own kill switch: the pool's signal forwards into it (app
    // quit), and the watchdogs pull it (silence, wall clock). Which one fired
    // decides whether this is a cancellation or a death.
    const abort = new AbortController();
    let killed: { mode: DeathMode; reason: string } | undefined;
    const kill = (mode: DeathMode, reason: string): void => {
      killed = { mode, reason };
      abort.abort();
    };
    const onOuterAbort = (): void => abort.abort();
    if (ctx.signal?.aborted) abort.abort();
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
    // Armed only once the provider is actually running — the dogfood preview
    // boot below is engine time, not provider time.
    let silenceTimer: NodeJS.Timeout | undefined;
    let wallClockTimer: NodeJS.Timeout | undefined;
    const resetSilence = (): void => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(
        () => kill("silence", `no provider output for ${this.#silenceMs}ms — killed`),
        this.#silenceMs,
      );
    };
    // Record the death, then throw it: the phase row and audit trail carry
    // the mode distinctly (ticket 41 AC1) before the retry decision upstream.
    const die = (mode: DeathMode, reason: string, providerSessionId?: string): PhaseDeathError => {
      this.store.endPhase(execution.id, "crashed", {
        failureReason: reason,
        deathMode: mode,
        providerSessionId,
      });
      return new PhaseDeathError(mode, reason);
    };
    // Re-entry context (spec 21, Phase Contract): follow-up criteria and the
    // Bounce Report the previous cycle left in the reused worktree. Statuses
    // ride along so a follow-up settled on an earlier cycle reads as such.
    const followUps = ctx.ticket.acceptanceCriteria
      .filter((criterion) => criterion.origin !== "original")
      .map((criterion) => `AC-${criterion.id} (${criterion.origin}, ${criterion.status}) ${criterion.text}`);
    // The dogfood phase (ticket 36) boots the ticket's Preview Environment
    // and joins the live URL + persona + vendored playbook to the variables.
    // A boot failure is never the phase's failure — the agent still runs and
    // writes an honest report (AC5); the teeth belong to slice 37's gate.
    const dogfood = node.bootsPreview ? await this.#bootDogfoodPreview(ctx) : undefined;
    try {
      // The engine's fixed template variable set — the only context injection.
      let prompt = renderTemplate(node.promptTemplate ?? "", {
        displayKey: ctx.ticket.displayKey,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        // AC-<id> gives check-emitting phases the ids their manifest keys on.
        acceptanceCriteria: ctx.ticket.acceptanceCriteria
          .map((criterion) => `- [${criterion.status}] AC-${criterion.id}: ${criterion.text}`)
          .join("\n"),
        branch: ctx.ticket.branch ?? "",
        targetBranch: ctx.repo.targetBranch,
        phase: node.name,
        priorKb: priorKb.length === 0 ? "none yet" : priorKb.join(", "),
        followUps: followUps.length === 0 ? "none" : followUps.join("; "),
        bounceReportPath: existsSync(path.join(ctx.worktreePath, BOUNCE_REPORT_PATH))
          ? BOUNCE_REPORT_PATH
          : "none",
        // Branch choices (ADR-0001): a branch node's phase must declare one of
        // these as its `outcome`; empty for a single-edge node ("none").
        outcomes: labels.length === 0 ? "none" : labels.join(", "),
        ...(dogfood?.vars ?? {}),
      });
      // A branching node whose author never templated {{outcomes}} still gets
      // the routing contract: the engine owns the outcome protocol, and a
      // phase that was never told to declare one dies a contract-breach it
      // could not have avoided (Pocock v2 shipped exactly this way).
      if (labels.length > 0 && !(node.promptTemplate ?? "").includes("{{outcomes}}")) {
        prompt += [
          "",
          "",
          "## Routing (engine contract)",
          `This phase ends at a branch. Start kb/${node.name}.md with YAML frontmatter declaring exactly one outcome:`,
          "",
          "---",
          `outcome: <one of: ${labels.join(", ")}>`,
          "---",
          "",
          "The run follows the edge whose label matches your declared outcome; the other branches never run. A missing or unlisted outcome crashes the run.",
        ].join("\n");
      }

      const log = this.logs.for(ctx.run.id);
      // In-phase verification (TRK-1): each invocation is one attempt at a
      // valid exit — provider run, contract checks, then the node's gate
      // subset. A gate failure re-prompts the SAME live session (resume) with
      // the findings, capped at PHASE_GATE_RETRIES; exhaustion is a death
      // that rides the existing once-retry/crash machinery upstream.
      let resumeSessionId: string | undefined;
      const brief = prompt;
      for (let attempt = 1; ; attempt += 1) {
        const handle = provider.runPhase(prompt, ctx.worktreePath, {
          signal: abort.signal,
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        });
        resetSilence();
        wallClockTimer = setTimeout(
          () => kill("timeout", `phase exceeded its ${this.#wallClockMs}ms wall clock — SIGTERM`),
          this.#wallClockMs,
        );
        let result: RunResult;
        try {
          for await (const event of handle.events) {
            resetSilence();
            log.append(RunLogRegistry.decorate(event, node.name));
          }
          result = await handle.done;
        } catch (error) {
          // A broken event stream with a live adapter promise is still a death,
          // not a stuck run — unless the app itself is going down. A watchdog's
          // SIGTERM may surface as the adapter rejecting: the kill keeps its
          // mode, or AC1's "audited distinctly" would misfile it as a crash.
          if (ctx.signal?.aborted) throw new PhaseCancelledError(`phase ${node.name} cancelled`);
          if (killed !== undefined) throw die(killed.mode, killed.reason);
          throw die("crash", `provider stream broke: ${messageOf(error)}`);
        }
        // The provider is done: disarm the watchdogs. The gate subset below
        // is engine time (a suite can take minutes) — a silence kill firing
        // over it would blame a child that already exited.
        clearTimeout(silenceTimer);
        clearTimeout(wallClockTimer);

        // Cancellation is the orchestrator's own doing (app quit): the phase
        // execution stays "running" and the startup sweep reaps the orphan —
        // recording a crash here would blame the work.
        if (ctx.signal?.aborted) {
          throw new PhaseCancelledError(`phase ${node.name} cancelled`);
        }
        // A watchdog pulled the kill switch: the provider's "cancelled" (or
        // whatever its dying breath reported) is our doing, not its own ending.
        if (killed !== undefined) {
          throw die(killed.mode, killed.reason, result.providerSessionId);
        }
        const providerSessionId = result.providerSessionId;
        if (result.outcome === "cancelled") {
          throw die("crash", "provider reported cancelled without an abort", providerSessionId);
        }
        if (result.outcome === "crashed") {
          throw die("crash", result.failureReason ?? "provider crashed", providerSessionId);
        }
        if (result.outcome === "failed") {
          throw die(
            "non-zero-exit",
            result.failureReason ?? "provider exited reporting failure",
            providerSessionId,
          );
        }
        const contract = path.join(ctx.worktreePath, "kb", `${node.name}.md`);
        if (!existsSync(contract)) {
          throw die(
            "hollow-exit",
            `contract file kb/${node.name}.md missing — phase is hollow`,
            providerSessionId,
          );
        }
        // Extended Phase Contract (ticket 07 §4): a check-emitting node must also
        // cover every pending AC in checks/manifest.json. Statuses are re-read —
        // a human may have waived an AC since claim. Re-read per attempt: a gate
        // retry may have rewritten checks along with the fix.
        let breach: string | undefined;
        if (node.emitsChecks) {
          const acs = this.store.getTicket(ctx.ticket.id)!.acceptanceCriteria;
          const manifest = readCheckManifest(ctx.worktreePath, acs);
          if (manifest.ok) {
            this.store.registerAcChecks(ctx.run.id, manifest.entries);
          } else {
            breach = manifest.failure;
          }
        }
        // Branch routing (ADR-0001): a node with labeled edges must have its
        // phase declare `outcome: <label>` in the contract. The engine only
        // string-matches — routing is the phase's judgment, never a gate — but a
        // missing or unrecognized outcome breaches the contract with the same
        // teeth as a hollow exit. A single-edge node ignores any stray one.
        let route: string | null = null;
        if (breach === undefined && labels.length > 0) {
          const declared = readContractOutcome(contract);
          if (declared === undefined) {
            breach = `phase ${node.name} declared no outcome — kb/${node.name}.md must set \`outcome:\` to one of: ${labels.join(", ")}`;
          } else if (!labels.includes(declared)) {
            breach = `phase ${node.name} declared outcome "${declared}" — expected one of: ${labels.join(", ")}`;
          } else {
            route = declared;
          }
        }
        if (breach !== undefined) {
          throw die("contract-breach", breach, providerSessionId);
        }
        // The node's gate subset (TRK-1, AC-30): a contract-clean exit is
        // only valid once its declared gates pass. Results are recorded
        // whichever way they go — visible on the Run and in the audit trail.
        const failures = await this.#runPhaseGates(ctx, node, attempt);
        // The gates took engine time; the app may have quit over them.
        if (ctx.signal?.aborted) {
          throw new PhaseCancelledError(`phase ${node.name} cancelled`);
        }
        if (failures.length === 0) {
          this.store.endPhase(execution.id, "completed", {
            providerSessionId,
            outcome: route ?? undefined,
          });
          return route;
        }
        if (attempt > PHASE_GATE_RETRIES) {
          throw die(
            "gate-exhausted",
            `phase ${node.name} still fails ${failures.map((f) => f.gate).join(", ")} ` +
              `after ${PHASE_GATE_RETRIES} in-phase gate retries`,
            providerSessionId,
          );
        }
        // Findings feed back into the same live session where the provider
        // can resume one; otherwise the re-brief must stand alone.
        resumeSessionId = provider.capabilities.supportsResume ? providerSessionId : undefined;
        prompt = gateRetryPrompt(
          node,
          failures,
          labels,
          resumeSessionId === undefined ? brief : undefined,
        );
      }
    } finally {
      clearTimeout(silenceTimer);
      clearTimeout(wallClockTimer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
      // The dogfood phase owns its preview for the phase's lifetime only: stop
      // it however the phase ends so the later demo step (and the wizard) boot
      // their own fresh process against the code under review.
      if (dogfood?.booted) await this.previews.stop(ctx.ticket.id, { actor: "agent" });
    }
  }

  /**
   * The node's in-phase gate subset (TRK-1, AC-30): lint what THIS node
   * declares it owes (gateRequirements — the research phase never dies on a
   * recap the document phase hasn't written yet), plus the repo suite. Every
   * result lands as a gate row and audit event the moment it settles, pass
   * or fail (AC-33); only the failures come back to drive the retry.
   */
  async #runPhaseGates(
    ctx: RunContext,
    node: WorkflowNode,
    attempt: number,
  ): Promise<PhaseGateFailure[]> {
    const problems = node.gateRequirements.flatMap((artifact) =>
      lintArtifact(ctx.worktreePath, artifact),
    );
    const suite = await evaluateSuite(ctx.repo.testCommand, ctx.worktreePath);
    const outcomes = [
      {
        gate: `${PHASE_GATE_PREFIX}artifact-lint`,
        status: problems.length === 0 ? ("pass" as const) : ("fail" as const),
        detail: { phase: node.name, attempt, required: node.gateRequirements, problems },
      },
      {
        gate: `${PHASE_GATE_PREFIX}suite`,
        status: suite.status,
        detail: { phase: node.name, attempt, ...suite.detail },
      },
    ];
    for (const outcome of outcomes) this.store.recordGateResult(ctx.run.id, outcome);
    return outcomes.filter((outcome) => outcome.status === "fail");
  }

  /**
   * Boot the ticket's Preview Environment for the dogfood phase and build its
   * slice of the template variables. No preview configured is not a failure —
   * the phase still runs, told honestly that no running app is available.
   */
  async #bootDogfoodPreview(
    ctx: RunContext,
  ): Promise<{ vars: Record<string, string>; booted: boolean }> {
    const persona = resolvePersona(ctx.repo, ctx.worktreePath);
    if (ctx.repo.previewCommand === null) {
      const handoff: PreviewHandoff = {
        available: false,
        note: "no preview configured for this repo",
      };
      return { vars: dogfoodTemplateVars(handoff, persona), booted: false };
    }
    const boot = await this.previews.bootReady(ctx.ticket.id, {
      timeoutMs: ctx.repo.previewReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      signal: ctx.signal,
      actor: "agent",
    });
    const handoff: PreviewHandoff = boot.ready
      ? { available: true, baseUrl: `http://localhost:${boot.port}` }
      : { available: false, note: boot.reason };
    return { vars: dogfoodTemplateVars(handoff, persona), booted: boot.ready };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed in-phase gate, as #runPhaseGates hands it to the retry prompt. */
interface PhaseGateFailure {
  gate: string;
  detail: Record<string, unknown>;
}

/**
 * The findings re-prompt (TRK-1, AC-31): deterministic render, structured
 * data first — same doctrine as the Bounce Report. For a resumed session the
 * findings stand alone; a provider that can't resume gets the original brief
 * appended, so a fresh session still has everything the phase was told.
 */
function gateRetryPrompt(
  node: WorkflowNode,
  failures: readonly PhaseGateFailure[],
  labels: readonly string[],
  brief?: string,
): string {
  const lines: string[] = [
    "## Phase gates failed (engine contract)",
    "",
    `Your ${node.name} phase exit was rejected: the engine ran this phase's gate subset and it failed.`,
    "",
  ];
  for (const failure of failures) {
    lines.push(`### ${failure.gate}`, "");
    const { output, phase: _phase, attempt: _attempt, ...rest } = failure.detail;
    for (const [key, value] of Object.entries(rest)) {
      lines.push(`- ${key}: ${Array.isArray(value) ? value.join("; ") : String(value)}`);
    }
    if (typeof output === "string" && output !== "") {
      lines.push("- output excerpt:", "", "```", output, "```");
    }
    lines.push("");
  }
  lines.push(
    "Fix these findings in this worktree, then finish the phase again: " +
      `write kb/${node.name}.md (update it if it already covers the phase)` +
      (labels.length === 0
        ? "."
        : `, its frontmatter still declaring \`outcome:\` as one of: ${labels.join(", ")}.`),
    "The gates re-run at your exit; the phase only completes when they pass.",
  );
  if (brief !== undefined) {
    lines.push(
      "",
      "## Original phase brief",
      "",
      "This is a fresh session (your provider cannot resume the prior one); the phase's original brief follows, and the prior attempt's work is already in the worktree.",
      "",
      brief,
    );
  }
  return lines.join("\n");
}

/** The engine's fixed template variable set (Phase Contract). */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

/**
 * The `outcome` a branching phase declared in its contract's leading YAML
 * frontmatter (`---` fenced). Returns undefined when the file has no
 * frontmatter block, no closing fence (malformed), or no `outcome:` key — all
 * of which the engine treats alike as an undeclared outcome.
 */
function readContractOutcome(contractPath: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(contractPath, "utf8"));
  if (!match) return undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^outcome:\s*(.+?)\s*$/.exec(line);
    if (kv) return kv[1]!.replace(/^["']|["']$/g, "").trim() || undefined;
  }
  return undefined;
}

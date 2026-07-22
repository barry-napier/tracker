import { readCheckManifest } from "./checks.ts";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Store } from "./store.ts";
import type { Repo, Run, TicketWithAcs } from "./types.ts";

/** A one-shot authoring session gets half a phase's wall clock. */
const AUTHOR_WALL_CLOCK_MS = 15 * 60_000;

/** How the log drawer labels the authoring session's blocks. */
const AUTHOR_PHASE_LABEL = "author-checks";

/**
 * Bounce-time check authoring (TRK-2, AC-37): Follow-up Criteria born from a
 * failed gate or review get their ac-check scripts written by a dedicated
 * provider session at bounce time — never by the session that will implement
 * against them. The scripts freeze (content hash) the moment the manifest
 * validates, exactly like the plan phase's, so the next Run's implementing
 * session inherits an exam it can read but not rewrite.
 *
 * Runs while the ticket still sits in Verifying/Human Review — states no
 * worker claims — so the session has the worktree to itself. Best-effort by
 * design: a crashed or non-covering authoring session is reported loudly and
 * the bounce proceeds — the next Run's plan phase covers any AC left
 * unchecked, which is exactly the pre-TRK-2 behavior.
 */
export class CheckAuthor {
  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly logs: RunLogRegistry,
  ) {}

  /** Resolves when the follow-ups' checks are registered, or the attempt is honestly given up. */
  async author(ctx: {
    run: Run;
    ticket: TicketWithAcs;
    repo: Repo;
    worktreePath: string;
    followUpAcIds: readonly number[];
  }): Promise<void> {
    if (ctx.followUpAcIds.length === 0) return;
    const provider = this.providers[ctx.ticket.provider ?? ""];
    if (!provider) {
      console.error(
        `run ${ctx.run.id}: no adapter for provider ${ctx.ticket.provider} — follow-up checks fall to the next plan phase`,
      );
      return;
    }
    // Fresh snapshot: the rows were minted moments ago.
    const ticket = this.store.getTicket(ctx.ticket.id)!;
    const followUps = ticket.acceptanceCriteria.filter((ac) => ctx.followUpAcIds.includes(ac.id));

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), AUTHOR_WALL_CLOCK_MS);
    const log = this.logs.for(ctx.run.id);
    try {
      const handle = provider.runPhase(authorPrompt(ticket, followUps), ctx.worktreePath, {
        signal: abort.signal,
      });
      for await (const event of handle.events) {
        log.append(RunLogRegistry.decorate(event, AUTHOR_PHASE_LABEL));
      }
      const result = await handle.done;
      if (result.outcome !== "completed") {
        console.error(
          `run ${ctx.run.id}: check authoring ended ${result.outcome}${
            result.failureReason === undefined ? "" : `: ${result.failureReason}`
          } — follow-up checks fall to the next plan phase`,
        );
        return;
      }
    } catch (error) {
      console.error(`run ${ctx.run.id}: check authoring crashed`, error);
      return;
    } finally {
      clearTimeout(timer);
    }

    // The trust boundary holds: the orchestrator re-reads the manifest and
    // freezes what it finds — coverage of every pending AC (the follow-ups
    // plus any pre-existing pending rows the plan already mapped), hashes
    // recorded before any implementing session exists.
    const manifest = readCheckManifest(ctx.worktreePath, ticket.acceptanceCriteria);
    if (!manifest.ok) {
      console.error(
        `run ${ctx.run.id}: check authoring left an invalid manifest (${manifest.failure}) — follow-up checks fall to the next plan phase`,
      );
      return;
    }
    this.store.registerAcChecks(ctx.run.id, manifest.entries);
  }
}

/**
 * The authoring brief. The opening line is a contract the test fake keys on;
 * the body mirrors the plan template's check instructions (db.ts migration 6)
 * so both authoring paths speak the same manifest dialect.
 */
function authorPrompt(
  ticket: TicketWithAcs,
  followUps: ReadonlyArray<{ id: number; text: string }>,
): string {
  return [
    `You are authoring verification checks for ticket ${ticket.displayKey}: ${ticket.title}.`,
    "",
    "This ticket just bounced. The following follow-up acceptance criteria were added; each needs a verification check before the next attempt begins:",
    "",
    ...followUps.map((ac) => `- AC-${ac.id}: ${ac.text}`),
    "",
    "For each criterion above: if it is machine-checkable, write an executable script " +
      "checks/ac-<id>.sh that exits 0 when the criterion holds; otherwise route it to a human. " +
      'Then update checks/manifest.json, keeping every existing entry and adding one per criterion above — a script path, or {"human": "<one-line reason>"}.',
    "",
    "Author checks only. Do not modify product code, existing check scripts, or anything under kb/.",
  ].join("\n");
}

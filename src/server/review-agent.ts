import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import type { Repo, Run, TicketWithAcs } from "./types.ts";

/** Worktree-relative; also the artifact name the wizard looks up. */
export const REVIEW_DIGEST_PATH = "kb/review-digest.json";
/** The artifact kind the digest persists under. */
export const REVIEW_DIGEST_KIND = "review-digest";

/** A digest session gets half a phase's wall clock, like check authoring. */
const DIGEST_WALL_CLOCK_MS = 15 * 60_000;

/** How the log drawer labels the digest session's blocks. */
const DIGEST_PHASE_LABEL = "review-digest";

export type DigestOutcome = { status: "produced" } | { status: "failed"; reason: string };

/**
 * The review agent (TRK-3): after every gate goes green — and before the
 * ticket enters Human Review — a dedicated session reads the finished diff
 * and pre-digests it for the human: an annotated walkthrough, risk
 * callouts, and an AC-to-code mapping, written as kb/review-digest.json and
 * persisted as Run evidence (so the artifact's worktree HEAD stamp makes
 * staleness provable, demo-fresh-style). The verdict stays human — the
 * digest only makes the wizard start informed instead of raw.
 *
 * Best-effort by design (AC-42): a dead or malformed digest is recorded as
 * such and the ticket still reaches Human Review with the raw-diff wizard.
 */
export class ReviewAgent {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly logs: RunLogRegistry,
    private readonly artifacts: ArtifactStore,
  ) {}

  /** Resolves for every ending; the outcome is the caller's to record. */
  async digest(ctx: {
    run: Run;
    ticket: TicketWithAcs;
    repo: Repo;
    worktreePath: string;
    signal?: AbortSignal;
  }): Promise<DigestOutcome> {
    const provider = this.providers[ctx.ticket.provider ?? ""];
    if (!provider) {
      return { status: "failed", reason: `no adapter for provider ${ctx.ticket.provider}` };
    }
    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort();
    if (ctx.signal?.aborted) abort.abort();
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), DIGEST_WALL_CLOCK_MS);
    const log = this.logs.for(ctx.run.id);
    try {
      const handle = provider.runPhase(digestPrompt(ctx.ticket, ctx.repo), ctx.worktreePath, {
        signal: abort.signal,
      });
      for await (const event of handle.events) {
        log.append(RunLogRegistry.decorate(event, DIGEST_PHASE_LABEL));
      }
      const result = await handle.done;
      if (result.outcome !== "completed") {
        return {
          status: "failed",
          reason: `digest session ended ${result.outcome}${
            result.failureReason === undefined ? "" : `: ${result.failureReason}`
          }`,
        };
      }
    } catch (error) {
      return {
        status: "failed",
        reason: `digest session crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    }

    const file = path.join(ctx.worktreePath, REVIEW_DIGEST_PATH);
    if (!existsSync(file)) {
      return { status: "failed", reason: `${REVIEW_DIGEST_PATH} missing — digest session was hollow` };
    }
    const problems = lintReviewDigest(readFileSync(file, "utf8"));
    if (problems.length > 0) {
      return { status: "failed", reason: `digest invalid: ${problems.join("; ")}` };
    }
    // Evidence, not decoration: the artifact row's worktree HEAD stamp is
    // what lets the wizard prove the findings match the code under review.
    await this.artifacts.persistFile(ctx.run.id, ctx.worktreePath, REVIEW_DIGEST_PATH, REVIEW_DIGEST_KIND);
    return { status: "produced" };
  }
}

/**
 * The digest's hard structure rules, checked before it becomes evidence:
 * all three sections present as arrays, every entry carrying its required
 * fields. Empty arrays are honest (a change can have no risks); anything
 * malformed fails the digest whole — the wizard degrades to raw-diff
 * rather than rendering half-trustworthy findings.
 */
export function lintReviewDigest(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return ["not valid JSON"];
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return ["digest must be a JSON object"];
  }
  const digest = doc as Record<string, unknown>;
  const problems: string[] = [];
  if (!Array.isArray(digest.walkthrough)) {
    problems.push("walkthrough must be an array");
  } else {
    for (const [index, entry] of digest.walkthrough.entries()) {
      const item = entry as Record<string, unknown>;
      if (typeof item?.file !== "string" || typeof item?.note !== "string") {
        problems.push(`walkthrough[${index}] needs string file and note`);
      }
    }
  }
  if (!Array.isArray(digest.risks)) {
    problems.push("risks must be an array");
  } else {
    for (const [index, entry] of digest.risks.entries()) {
      const item = entry as Record<string, unknown>;
      if (typeof item?.note !== "string") {
        problems.push(`risks[${index}] needs a string note`);
      }
    }
  }
  if (!Array.isArray(digest.acMap)) {
    problems.push("acMap must be an array");
  } else {
    for (const [index, entry] of digest.acMap.entries()) {
      const item = entry as Record<string, unknown>;
      if (typeof item?.acId !== "number" || typeof item?.note !== "string") {
        problems.push(`acMap[${index}] needs a numeric acId and a string note`);
      }
    }
  }
  return problems;
}

/**
 * The digest brief. The opening line is a contract the test fake keys on;
 * the schema in the prompt is the same one lintReviewDigest enforces.
 */
function digestPrompt(ticket: TicketWithAcs, repo: Repo): string {
  return [
    `You are pre-digesting the change for human review of ticket ${ticket.displayKey}: ${ticket.title}.`,
    "",
    ticket.description,
    "",
    "Acceptance criteria:",
    ...ticket.acceptanceCriteria.map(
      (criterion) => `- [${criterion.status}] AC-${criterion.id}: ${criterion.text}`,
    ),
    "",
    `Every gate passed; a human reviews next. Read the change (git diff ${repo.targetBranch}...HEAD) ` +
      `and write ${REVIEW_DIGEST_PATH} — JSON, no prose around it:`,
    "",
    "{",
    '  "walkthrough": [{"file": "<path>", "note": "<what to see here, in reading order>"}],',
    '  "risks": [{"note": "<what could bite>", "severity": "low|medium|high"}],',
    '  "acMap": [{"acId": <id>, "note": "<where this criterion is satisfied>", "files": ["<path>"]}]',
    "}",
    "",
    "Annotate the diff for a reviewer who has not seen it: walk it in the order it should be read, " +
      "call out risk where it lives, and map every acceptance criterion above to the code that earns it. " +
      "Empty arrays are honest answers. Do not modify any file except the digest.",
  ].join("\n");
}

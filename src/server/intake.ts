import type { AgentEvent, Provider } from "./provider.ts";
import type { RunLog } from "./runlog.ts";
import { RunLogRegistry } from "./runlog.ts";
import type {
  IntakeAcDraft,
  IntakeDraft,
  IntakeKind,
  IntakeQuestion,
  IntakeTurn,
} from "./types.ts";

/**
 * AI ticket intake: the grilling conversation that authors a ticket before
 * anything enters Backlog. Same shape as the workflow-edit chat — one
 * provider phase per turn, the stored transcript is the conversation state,
 * the model answers with a fenced JSON block — but the cwd is the real repo
 * and research (read-only tool use) is the point, not forbidden.
 *
 * Why this exists at all: TRA-1 showed that a one-line human ticket forces
 * every downstream run to reverse-engineer the spec. Intake does that work
 * once — research the repo, ask only the decisions the repo can't answer,
 * and emit ACs that are either machine-checkable (with a calibratable check
 * sketch) or explicitly routed to human judgment with the reason.
 */

export interface IntakeAgentTurn {
  ok: true;
  turn: IntakeTurn & { role: "agent" };
}
export interface IntakeFailure {
  ok: false;
  error: string;
}

const CONTRACT = `Answer with exactly one fenced JSON block and nothing after it. It must be ONE of:

A question — one real decision, options numbered for a quick reply:
\`\`\`json
{"question": {"text": "<the decision, concretely>",
  "options": ["<option 1>", "<option 2>"],
  "why": "<why the repo's docs/code cannot answer this>"}}
\`\`\`

Or the finished draft:
\`\`\`json
{"draft": {"title": "<sharp imperative title>",
  "description": "<what and why; MUST name the authority documents each AC leans on, e.g. 'consistent = conforms to DESIGN.md Components → Button'>",
  "acs": [
    {"text": "<criterion>", "route": "check",
     "checkSketch": "<shell sketch for a checks/ac-<id>.sh script; it must be calibratable — it would demonstrably FAIL against the current tree and pass after the work>"},
    {"text": "<criterion>", "route": "human",
     "humanReason": "<why no machine check can decide this>"}
  ]},
 "note": "<optional: one sentence on what you resolved from the repo without asking>"}
\`\`\``;

/**
 * The ticket template per kind: the format the draft's description must
 * follow. Picked by the requester up front — a bug interrogation and an
 * initiative interrogation are different conversations.
 */
const TEMPLATES: Record<IntakeKind, string> = {
  bug: `Create a BUG ticket based on the following format. The description must fill every section:

## Observed
<what actually happens, with the concrete surface (view/route/command) it happens on>

## Expected
<what should happen, citing the authority document or prior behavior that says so>

## Reproduction
<numbered steps from a clean state>

## Suspected cause
<file:line pointers from your research; "unknown" only if the code genuinely doesn't say>

ACs for a bug: at least one check-routed AC that reproduces the defect (fails today, passes when fixed), plus a regression guard where one is cheap.`,
  feature: `Create a FEATURE ticket based on the following format. The description must fill every section:

## Why
<the user problem or motivation, one paragraph>

## What
<the behavior being added, concrete enough that an implementing agent never guesses; name the authority documents each decision leans on>

## Out of scope
<what a reasonable implementer might include but must not>

ACs for a feature: each user-visible behavior gets its own AC, routed to a check where a script can decide it and to human where only judgment can.`,
  initiative: `Create a LARGE INITIATIVE ticket based on the following format. The description must fill every section:

## Goal
<the end state, one paragraph>

## Motivation
<why now; what it unblocks>

## Scope
In: <bulleted>
Out: <bulleted — be aggressive here; initiatives die of scope>

## Suggested breakdown
<3-7 candidate child tickets, one line each — this ticket is the umbrella; the breakdown seeds the follow-up tickets>

ACs for an initiative: define "done" for the umbrella itself (e.g. every child ticket filed, a measurable end state reached) — mostly human-routed, with checks only where an end state is mechanically observable.`,
};

const RULES = `Rules — these are hard:
- RESEARCH FIRST. Read DESIGN.md, CONTEXT.md, docs/adr/, and the code the intent touches before saying anything. You have read-only use of the repo: do not modify, create, or delete any file, do not run anything with side effects.
- NEVER ask what the repo already answers. If DESIGN.md or an ADR settles it, cite it in the description instead of asking. "Which file holds the styles?" is a forbidden question; "destructive dialog confirms — red or contrast primary?" is a real one (only if the docs genuinely don't say).
- ONE question per turn, and only questions whose answer changes the ticket. If nothing real remains to ask, emit the draft.
- Aim for at most 2-3 questions total. Vague intents deserve grilling; crisp ones may go straight to a draft.
- Every AC must be atomic and testable in principle. Route each to "check" with a sketch, or to "human" with the reason. A check sketch that could never fail on the current tree is worthless — say what it greps/runs and why it fails today.
- The description must name its authority documents so a future run never has to guess what "correctly" means.`;

function transcriptLines(intent: string, turns: IntakeTurn[]): string {
  const lines = [`Requester's intent: ${intent}`];
  for (const turn of turns) {
    if (turn.role === "user") lines.push(`Requester answered: ${turn.text}`);
    else if ("question" in turn) lines.push(`You asked: ${turn.question.text}`);
    else lines.push(`You drafted: ${JSON.stringify(turn.draft)}`);
  }
  return lines.join("\n");
}

export function buildIntakePrompt(kind: IntakeKind, intent: string, turns: IntakeTurn[]): string {
  return `You are the ticket-intake agent for this repository. A requester wants work done; your job is to research the repo, grill them on the real decisions, and author a ticket sharp enough that an implementing agent never has to reverse-engineer the spec.

${TEMPLATES[kind]}

${RULES}

Conversation so far:
${transcriptLines(intent, turns)}

${turns.some((t) => t.role === "agent") ? "Continue: either ask the next real question, or emit the draft if nothing real remains." : "Begin by researching the repo, then ask your first question or emit the draft."}

${CONTRACT}`;
}

function shapedAc(value: unknown): IntakeAcDraft | undefined {
  const ac = value as Partial<IntakeAcDraft>;
  if (typeof ac?.text !== "string" || ac.text.trim() === "") return undefined;
  if (ac.route !== "check" && ac.route !== "human") return undefined;
  return {
    text: ac.text.trim(),
    route: ac.route,
    checkSketch: typeof ac.checkSketch === "string" ? ac.checkSketch : undefined,
    humanReason: typeof ac.humanReason === "string" ? ac.humanReason : undefined,
  };
}

/** The last fenced JSON block wins — models sometimes think out loud first. */
export function parseIntakeResponse(text: string): IntakeAgentTurn | IntakeFailure {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = blocks.at(-1)?.[1] ?? text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "the model's answer contained no parseable JSON block" };
  }
  const body = parsed as { question?: unknown; draft?: unknown; note?: unknown };

  if (body.question !== undefined) {
    const q = body.question as Partial<IntakeQuestion>;
    if (typeof q?.text !== "string" || typeof q?.why !== "string") {
      return { ok: false, error: "the model's question was missing text or why" };
    }
    const options = Array.isArray(q.options)
      ? q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "")
      : undefined;
    const question: IntakeQuestion = { text: q.text, why: q.why };
    if (options !== undefined && options.length > 0) question.options = options;
    return { ok: true, turn: { role: "agent", question } };
  }

  if (body.draft !== undefined) {
    const d = body.draft as Partial<IntakeDraft>;
    if (typeof d?.title !== "string" || typeof d?.description !== "string" || !Array.isArray(d.acs)) {
      return { ok: false, error: "the model's draft was missing title, description, or acs" };
    }
    const acs = d.acs.map(shapedAc);
    if (acs.length === 0 || acs.some((ac) => ac === undefined)) {
      return { ok: false, error: "the model's draft had missing or malformed acceptance criteria" };
    }
    const turn: { role: "agent"; draft: IntakeDraft; note?: string } = {
      role: "agent",
      draft: { title: d.title, description: d.description, acs: acs as IntakeAcDraft[] },
    };
    if (typeof body.note === "string" && body.note.trim() !== "") turn.note = body.note;
    return { ok: true, turn };
  }

  return { ok: false, error: "the model's JSON carried neither question nor draft" };
}

/** Concatenated `text` blocks, teeing every event into the session log. */
async function collectText(events: AsyncIterable<AgentEvent>, log: RunLog): Promise<string> {
  const open = new Map<string, { kind: string; text: string }>();
  const closed: string[] = [];
  for await (const event of events) {
    log.append(RunLogRegistry.decorate(event, "intake"));
    if (event.type === "block.open") {
      open.set(event.blockId, { kind: event.block.kind, text: "text" in event.block ? event.block.text : "" });
    } else if (event.type === "block.delta") {
      const block = open.get(event.blockId);
      if (block) block.text += event.textDelta;
    } else {
      const block = open.get(event.blockId);
      open.delete(event.blockId);
      if (block?.kind === "text") closed.push(block.text);
    }
  }
  // A provider that never closed its blocks still gets its text counted.
  for (const block of open.values()) if (block.kind === "text") closed.push(block.text);
  return closed.join("\n");
}

/**
 * One intake turn: research can take a while, so the deadline is generous
 * and every provider event streams into the session's log for the live view.
 */
export async function runIntakeTurn(
  provider: Provider,
  kind: IntakeKind,
  intent: string,
  turns: IntakeTurn[],
  cwd: string,
  log: RunLog,
  timeoutMs = 600_000,
): Promise<IntakeAgentTurn | IntakeFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handle = provider.runPhase(buildIntakePrompt(kind, intent, turns), cwd, {
      signal: controller.signal,
    });
    const [text, result] = await Promise.all([collectText(handle.events, log), handle.done]);
    if (result.outcome !== "completed") {
      return {
        ok: false,
        error: result.failureReason ?? `the provider ${result.outcome === "cancelled" ? "timed out" : result.outcome}`,
      };
    }
    return parseIntakeResponse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The draft as `store.createTicket` takes it. Check sketches and human
 * routes ride in a "Suggested checks" description section keyed by AC
 * position — AC ids don't exist until creation; the plan phase writes the
 * real checks/ac-<id>.sh and can crib the sketch from here.
 */
export function draftToTicketInput(draft: IntakeDraft): {
  title: string;
  description: string;
  acceptanceCriteria: string[];
} {
  const sections = draft.acs.map((ac, i) => {
    const heading = `### AC ${i + 1} — ${ac.text}`;
    if (ac.route === "human") {
      return `${heading}\n\nRoute: **human** — ${ac.humanReason ?? "needs human judgment"}`;
    }
    const sketch = ac.checkSketch ? `\n\n\`\`\`sh\n${ac.checkSketch.trim()}\n\`\`\`` : "";
    return `${heading}\n\nRoute: **check**${sketch}`;
  });
  return {
    title: draft.title,
    description: `${draft.description.trim()}\n\n## Suggested checks\n\n${sections.join("\n\n")}`,
    acceptanceCriteria: draft.acs.map((ac) => ac.text),
  };
}

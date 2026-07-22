import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { EventBus } from "../src/server/bus.ts";
import { openDatabase } from "../src/server/db.ts";
import { NotFoundError, Store, ValidationError } from "../src/server/store.ts";
import type { IntakeBreakdown } from "../src/server/types.ts";
import { initScratchRepo } from "./git-helpers.ts";
import { cleanups, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

async function harness(): Promise<{ db: DatabaseSync; store: Store }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-deps-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const db = openDatabase(dataDir);
  cleanups.push(async () => db.close());
  return { db, store: new Store(db, new EventBus()) };
}

/** A project on the migration-seeded default workflow, with a scratch repo. */
function seedProject(db: DatabaseSync, store: Store, name: string) {
  const workflowId = Number(
    db.prepare("SELECT id FROM workflows WHERE is_default = 1").get()!.id,
  );
  const project = store.createProject({ name, workflowId });
  const source = initScratchRepo("fixture");
  cleanups.push(() => rm(path.dirname(source), { recursive: true, force: true }));
  const repo = store.createRepo({
    projectId: project.id,
    path: source,
    githubRemote: `git@github.com:x/${name}.git`,
  });
  return { project, repo };
}

describe("ticket dependencies (ADR-0007)", () => {
  test("blockedBy lands on the ticket and reads back with state and displayKey", async () => {
    const { db, store } = await harness();
    const { project } = seedProject(db, store, "deps");
    const blocker = store.createTicket({
      projectId: project.id,
      title: "Lay the pipe",
      acceptanceCriteria: [],
    });
    const dependent = store.createTicket({
      projectId: project.id,
      title: "Pump the water",
      acceptanceCriteria: [],
      blockedBy: [blocker.id, blocker.id], // duplicates collapse
    });
    expect(dependent.blockedBy).toEqual([
      { ticketId: blocker.id, displayKey: blocker.displayKey, state: "backlog" },
    ]);
    expect(blocker.blockedBy).toEqual([]);
  });

  test("a missing or cross-project blocker refuses the create", async () => {
    const { db, store } = await harness();
    const { project } = seedProject(db, store, "deps-a");
    const { project: other } = seedProject(db, store, "deps-b");
    const foreign = store.createTicket({
      projectId: other.id,
      title: "Elsewhere",
      acceptanceCriteria: [],
    });
    const base = { projectId: project.id, title: "T", acceptanceCriteria: [] };
    expect(() => store.createTicket({ ...base, blockedBy: [999] })).toThrow(NotFoundError);
    expect(() => store.createTicket({ ...base, blockedBy: [foreign.id] })).toThrow(
      ValidationError,
    );
  });

  test("claim skips a blocked ticket and takes it once every blocker is done", async () => {
    const { db, store } = await harness();
    const { project, repo } = seedProject(db, store, "claim");
    const blocker = store.createTicket({
      projectId: project.id,
      title: "First",
      acceptanceCriteria: [],
    });
    const dependent = store.createTicket({
      projectId: project.id,
      title: "Second",
      acceptanceCriteria: [],
      blockedBy: [blocker.id],
    });
    // Promote in id order — the dependent would win the ORDER BY tie-break
    // only through its blocker; both sit in Todo.
    store.promoteTicket(blocker.id, { repoId: repo.id, provider: "claude-code" });
    store.promoteTicket(dependent.id, { repoId: repo.id, provider: "claude-code" });

    // The blocker is claimed; the dependent is not claimable while the
    // blocker is merely in_progress.
    expect(store.claimNextTicket()!.ticket.id).toBe(blocker.id);
    expect(store.claimNextTicket()).toBeUndefined();

    // Blocker done → the dependent is the next claim.
    db.prepare("UPDATE runs SET state = 'completed' WHERE ticket_id = ?").run(blocker.id);
    db.prepare("UPDATE tickets SET state = 'done' WHERE id = ?").run(blocker.id);
    expect(store.claimNextTicket()!.ticket.id).toBe(dependent.id);
  });

  test("a breakdown wires earlier-index blockers to real ids and refuses forward references", async () => {
    const { db, store } = await harness();
    const { project, repo } = seedProject(db, store, "breakdown");
    const breakdown: IntakeBreakdown = {
      destination: "A watered garden",
      tickets: [],
      notYetSpecified: [],
      outOfScope: [],
    };
    const inputs = (blockedBy: number[][]) =>
      blockedBy.map((refs, i) => ({
        kind: "feature" as const,
        title: `Slice ${i}`,
        description: "## Why\nx\n## What\nx\n## Out of scope\nx",
        acceptanceCriteria: [`AC ${i}`],
        blockedBy: refs,
      }));

    const forward = store.createIntakeSession({
      projectId: project.id,
      repoId: repo.id,
      provider: "claude-code",
      kind: "initiative",
      intent: "water the garden",
    });
    expect(() =>
      store.approveIntakeBreakdown(forward.id, breakdown, inputs([[1], []])),
    ).toThrow(ValidationError);
    // Nothing was stranded on the board by the refused batch.
    expect(store.listTickets(project.id)).toHaveLength(0);

    const session = store.createIntakeSession({
      projectId: project.id,
      repoId: repo.id,
      provider: "claude-code",
      kind: "initiative",
      intent: "water the garden",
    });
    const { tickets } = store.approveIntakeBreakdown(
      session.id,
      breakdown,
      inputs([[], [0], [0, 1]]),
    );
    expect(tickets[1]!.blockedBy.map((b) => b.ticketId)).toEqual([tickets[0]!.id]);
    expect(tickets[2]!.blockedBy.map((b) => b.ticketId)).toEqual([
      tickets[0]!.id,
      tickets[1]!.id,
    ]);
  });
});

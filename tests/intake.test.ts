import { afterEach, describe, expect, test } from "vitest";
import { FakeProvider } from "../src/server/providers/fake.ts";
import { draftToTicketInput, parseIntakeResponse } from "../src/server/intake.ts";
import { api, bootServer, cleanups, runCleanups, seedWorkspace } from "./server-helpers.ts";

afterEach(runCleanups);

/** A provider that answers every phase with the given final text. */
function chattyProvider(text: string): FakeProvider {
  return new FakeProvider(async function* () {
    yield { type: "block.open", blockId: "b1", block: { kind: "text", text } };
    yield { type: "block.close", blockId: "b1" };
    return { outcome: "completed" };
  });
}

const QUESTION = `\`\`\`json\n${JSON.stringify({
  question: {
    text: "Destructive dialog confirms — red or contrast primary?",
    options: ["red", "contrast primary"],
    why: "DESIGN.md names both without ranking them",
  },
})}\n\`\`\``;

const DRAFT = `\`\`\`json\n${JSON.stringify({
  draft: {
    title: "Make buttons conform to DESIGN.md",
    description: "consistent = conforms to DESIGN.md Components → Button",
    acs: [
      {
        text: "No raw hex colors in button styles",
        route: "check",
        checkSketch: "! grep -rn '#[0-9a-f]\\{6\\}' src/renderer/styles.css",
      },
      { text: "Buttons feel consistent", route: "human", humanReason: "visual judgment" },
    ],
  },
  note: "Resolved token names from DESIGN.md without asking.",
})}\n\`\`\``;

describe("intake sessions", () => {
  test("create, grill, draft, approve → ticket in backlog with suggested checks", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(QUESTION) },
    });
    const { project, repo } = await seedWorkspace(server);

    const created = await api(server, "POST", "/api/intake", {
      projectId: project.id,
      repoId: repo.id,
      kind: "bug",
      intent: "make buttons consistent",
    });
    expect(created.status).toBe(201);
    expect(created.json.status).toBe("active");
    expect(created.json.kind).toBe("bug");
    // Omitted kind defaults to feature; an unknown kind is refused.
    expect(
      (
        await api(server, "POST", "/api/intake", {
          projectId: project.id,
          repoId: repo.id,
          intent: "x",
        })
      ).json.kind,
    ).toBe("feature");
    expect(
      (
        await api(server, "POST", "/api/intake", {
          projectId: project.id,
          repoId: repo.id,
          kind: "epic",
          intent: "x",
        })
      ).status,
    ).toBe(400);

    // First turn: the fake asks its question.
    const first = await api(server, "POST", `/api/intake/${created.json.id}/retry`, {});
    expect(first.status).toBe(200);
    expect(first.json.transcript).toHaveLength(1);
    expect(first.json.transcript[0].question.options).toHaveLength(2);
    expect(first.json.status).toBe("active");

    // Swap the canned answer to the draft and answer the question.
    // (FakeProvider is stateless per phase; re-boot the registry instead.)
    await runCleanups();
    const server2 = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(DRAFT) },
    });
    const seeded = await seedWorkspace(server2);
    const session = (
      await api(server2, "POST", "/api/intake", {
        projectId: seeded.project.id,
        repoId: seeded.repo.id,
        intent: "make buttons consistent",
      })
    ).json;
    const drafted = await api(server2, "POST", `/api/intake/${session.id}/reply`, {
      message: "red",
    });
    expect(drafted.status).toBe(200);
    expect(drafted.json.status).toBe("drafted");
    expect(drafted.json.draft.acs).toHaveLength(2);
    // The user's answer and the agent's draft both persisted.
    expect(drafted.json.transcript.map((t: { role: string }) => t.role)).toEqual([
      "user",
      "agent",
    ]);

    const approved = await api(server2, "POST", `/api/intake/${session.id}/approve`, {});
    expect(approved.status).toBe(201);
    const ticket = approved.json.ticket;
    expect(ticket.state).toBe("backlog");
    expect(ticket.title).toBe("Make buttons conform to DESIGN.md");
    expect(ticket.description).toContain("## Suggested checks");
    expect(ticket.description).toContain("Route: **human** — visual judgment");
    expect(ticket.acceptanceCriteria).toHaveLength(2);
    expect(approved.json.session.status).toBe("approved");
    expect(approved.json.session.ticketId).toBe(ticket.id);

    // Approved sessions leave the open list and refuse further turns.
    const listed = (await api(server2, "GET", `/api/intake?projectId=${seeded.project.id}`)).json;
    expect(listed).toHaveLength(0);
    expect((await api(server2, "POST", `/api/intake/${session.id}/reply`, { message: "x" })).status).toBe(400);
  });

  test("an edited draft wins over the session's", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(DRAFT) },
    });
    const { project, repo } = await seedWorkspace(server);
    const session = (
      await api(server, "POST", "/api/intake", {
        projectId: project.id,
        repoId: repo.id,
        intent: "buttons",
      })
    ).json;
    await api(server, "POST", `/api/intake/${session.id}/retry`, {});
    const approved = await api(server, "POST", `/api/intake/${session.id}/approve`, {
      draft: {
        title: "Edited title",
        description: "edited",
        acs: [{ text: "Only AC", route: "human", humanReason: "because" }],
      },
    });
    expect(approved.status).toBe(201);
    expect(approved.json.ticket.title).toBe("Edited title");
    expect(approved.json.ticket.acceptanceCriteria).toHaveLength(1);
  });

  test("a non-JSON answer is a 502 and persists nothing", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider("I refuse to answer in JSON.") },
    });
    const { project, repo } = await seedWorkspace(server);
    const session = (
      await api(server, "POST", "/api/intake", {
        projectId: project.id,
        repoId: repo.id,
        intent: "buttons",
      })
    ).json;
    const failed = await api(server, "POST", `/api/intake/${session.id}/reply`, {
      message: "an answer",
    });
    expect(failed.status).toBe(502);
    const reloaded = (await api(server, "GET", `/api/intake/${session.id}`)).json;
    expect(reloaded.transcript).toHaveLength(0);
  });

  test("approve without a draft is a 400; discard closes the session", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(QUESTION) },
    });
    const { project, repo } = await seedWorkspace(server);
    const session = (
      await api(server, "POST", "/api/intake", {
        projectId: project.id,
        repoId: repo.id,
        intent: "buttons",
      })
    ).json;
    expect((await api(server, "POST", `/api/intake/${session.id}/approve`, {})).status).toBe(400);
    const discarded = await api(server, "DELETE", `/api/intake/${session.id}`);
    expect(discarded.json.status).toBe("discarded");
    expect((await api(server, "GET", `/api/intake?projectId=${project.id}`)).json).toHaveLength(0);
  });

  test("cross-project repo is refused; missing rows are 404s", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(QUESTION) },
    });
    const { repo } = await seedWorkspace(server);
    const other = (await api(server, "POST", "/api/projects", { name: "Other" })).json;
    const crossed = await api(server, "POST", "/api/intake", {
      projectId: other.id,
      repoId: repo.id,
      intent: "buttons",
    });
    expect(crossed.status).toBe(400);
    expect((await api(server, "GET", "/api/intake/999")).status).toBe(404);
  });
});

describe("parseIntakeResponse", () => {
  test("takes the last fenced block; question or draft required", () => {
    const q = parseIntakeResponse(
      `preamble\n\`\`\`json\n{"wrong": 1}\n\`\`\`\n${QUESTION}`,
    );
    expect(q).toMatchObject({ ok: true });
    expect(parseIntakeResponse("no json").ok).toBe(false);
    expect(parseIntakeResponse('```json\n{"neither": true}\n```').ok).toBe(false);
    expect(
      parseIntakeResponse('```json\n{"question": {"text": "x"}}\n```').ok,
    ).toBe(false); // missing why
    expect(
      parseIntakeResponse('```json\n{"draft": {"title": "t", "description": "d", "acs": []}}\n```')
        .ok,
    ).toBe(false); // no ACs
    expect(
      parseIntakeResponse(
        '```json\n{"draft": {"title": "t", "description": "d", "acs": [{"text": "a", "route": "nope"}]}}\n```',
      ).ok,
    ).toBe(false); // bad route
  });
});

describe("draftToTicketInput", () => {
  test("appends a Suggested checks section keyed by AC position", () => {
    const input = draftToTicketInput({
      title: "T",
      description: "D",
      acs: [
        { text: "a", route: "check", checkSketch: "exit 1" },
        { text: "b", route: "human", humanReason: "taste" },
      ],
    });
    expect(input.acceptanceCriteria).toEqual(["a", "b"]);
    expect(input.description).toContain("### AC 1 — a");
    expect(input.description).toContain("```sh\nexit 1\n```");
    expect(input.description).toContain("### AC 2 — b");
    expect(input.description).toContain("**human** — taste");
  });
});

describe("buildIntakePrompt", () => {
  test("leads with the kind's ticket template", async () => {
    const { buildIntakePrompt } = await import("../src/server/intake.ts");
    expect(buildIntakePrompt("bug", "x", [])).toContain("Create a BUG ticket based on the following format");
    expect(buildIntakePrompt("initiative", "x", [])).toContain("NAME THE DESTINATION");
    expect(buildIntakePrompt("initiative", "x", [])).toContain("notYetSpecified");
    expect(buildIntakePrompt("feature", "x", [])).toContain("Out of scope");
  });
});

const BREAKDOWN = `\`\`\`json\n${JSON.stringify({
  breakdown: {
    destination: "Provider seam supports streaming partial text everywhere",
    tickets: [
      {
        kind: "feature",
        title: "Stream deltas in the workflow chat",
        description: "## Why\nx\n\n## What\ny\n\n## Out of scope\nz",
        acs: [{ text: "Chat renders deltas", route: "human", humanReason: "visual" }],
      },
      {
        kind: "bug",
        title: "Log view drops unclosed blocks",
        description: "## Observed\nx\n\n## Expected\ny\n\n## Reproduction\n1. z\n\n## Suspected cause\nq",
        acs: [{ text: "Unclosed blocks render", route: "check", checkSketch: "exit 1" }],
      },
    ],
    notYetSpecified: ["Cost reporting shape for streamed runs"],
    outOfScope: ["Rewriting the ACP transport"],
  },
  note: "Named the destination from the intent without asking.",
})}\n\`\`\``;

describe("initiative sessions (wayfinder-shaped)", () => {
  test("breakdown → approve files feature/bug tickets; fog keeps the session open", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(BREAKDOWN) },
    });
    const { project, repo } = await seedWorkspace(server);
    const session = (
      await api(server, "POST", "/api/intake", {
        projectId: project.id,
        repoId: repo.id,
        kind: "initiative",
        intent: "streaming everywhere",
      })
    ).json;

    const charted = await api(server, "POST", `/api/intake/${session.id}/retry`, {});
    expect(charted.status).toBe(200);
    expect(charted.json.status).toBe("drafted");
    expect(charted.json.draft).toBeNull();
    expect(charted.json.breakdown.tickets).toHaveLength(2);
    expect(charted.json.breakdown.notYetSpecified).toHaveLength(1);

    const approved = await api(server, "POST", `/api/intake/${session.id}/approve`, {});
    expect(approved.status).toBe(201);
    expect(approved.json.tickets).toHaveLength(2);
    expect(approved.json.tickets.map((t: { kind: string }) => t.kind)).toEqual([
      "feature",
      "bug",
    ]);
    expect(approved.json.tickets[0].state).toBe("backlog");
    expect(approved.json.tickets[1].description).toContain("## Suggested checks");
    // Fog remains → the session stays open with an emptied ticket batch.
    expect(approved.json.session.status).toBe("drafted");
    expect(approved.json.session.breakdown.tickets).toHaveLength(0);
    expect(approved.json.session.breakdown.notYetSpecified).toHaveLength(1);
    // Nothing left to file → a second approve is refused.
    expect((await api(server, "POST", `/api/intake/${session.id}/approve`, {})).status).toBe(400);
  });

  test("a fog-free breakdown closes the session on approval", async () => {
    const clear = BREAKDOWN.replace(
      '"notYetSpecified":["Cost reporting shape for streamed runs"]',
      '"notYetSpecified":[]',
    );
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(clear) },
    });
    const { project, repo } = await seedWorkspace(server);
    const session = (
      await api(server, "POST", "/api/intake", {
        projectId: project.id,
        repoId: repo.id,
        kind: "initiative",
        intent: "streaming everywhere",
      })
    ).json;
    await api(server, "POST", `/api/intake/${session.id}/retry`, {});
    const approved = await api(server, "POST", `/api/intake/${session.id}/approve`, {});
    expect(approved.status).toBe(201);
    expect(approved.json.session.status).toBe("approved");
  });

  test("initiative never lands as a ticket kind", async () => {
    const server = await bootServer(undefined, {
      providers: { "claude-code": chattyProvider(BREAKDOWN) },
    });
    const { project } = await seedWorkspace(server);
    const refused = await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "umbrella",
      kind: "initiative",
      acceptanceCriteria: ["x"],
    });
    expect(refused.status).toBe(400);
  });
});

describe("parseIntakeResponse breakdown shape", () => {
  test("rejects initiative-kind tickets and empty breakdowns", () => {
    const bad = (b: unknown) =>
      parseIntakeResponse(`\`\`\`json\n${JSON.stringify({ breakdown: b })}\n\`\`\``).ok;
    expect(
      bad({ destination: "d", tickets: [{ kind: "initiative", title: "t", description: "d", acs: [{ text: "a", route: "human" }] }], notYetSpecified: [] }),
    ).toBe(false);
    expect(bad({ destination: "d", tickets: [], notYetSpecified: [] })).toBe(false);
    expect(
      bad({ destination: "d", tickets: [], notYetSpecified: ["fog remains"] }),
    ).toBe(true);
  });
});

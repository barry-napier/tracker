import { describe, expect, test } from "vitest";
import type { TeamPr } from "../src/server/github.ts";
import {
  applyView,
  DEFAULT_TEAM_PREFS,
  DEFAULT_VIEW,
  restoreTeamPrefs,
  type TeamView,
} from "../src/renderer/teamPrefs.ts";

describe("team prefs persistence", () => {
  test("round-trips through JSON", () => {
    const prefs = {
      repos: ["barry/a", "barry-napier/project-scaffold"],
      views: [
        {
          id: "v1",
          name: "Failing",
          query: "fix",
          checks: "failing",
          draft: "hide",
          author: "barry",
          sort: "comments",
        },
      ],
    };
    expect(restoreTeamPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  test("null, garbage, and non-object payloads restore to defaults", () => {
    expect(restoreTeamPrefs(null)).toEqual(DEFAULT_TEAM_PREFS);
    expect(restoreTeamPrefs("not json {")).toEqual(DEFAULT_TEAM_PREFS);
    expect(restoreTeamPrefs("42")).toEqual(DEFAULT_TEAM_PREFS);
  });

  test("drops non-string, non-slug, and duplicate entries", () => {
    const raw = JSON.stringify({
      repos: ["barry/a", 7, "no-slash", "evil/../path", "barry/a", "ok/repo.js"],
    });
    expect(restoreTeamPrefs(raw)).toEqual({ repos: ["barry/a", "ok/repo.js"], views: [] });
  });

  test("views: rows missing identity drop; bad filter fields default per-field", () => {
    const raw = JSON.stringify({
      repos: [],
      views: [
        { id: "", name: "no id" },
        { id: "v1", name: "  " },
        "not-an-object",
        { id: "v2", name: "Kept", checks: "bogus", draft: 42, sort: null, query: 7, author: [] },
      ],
    });
    expect(restoreTeamPrefs(raw).views).toEqual([{ id: "v2", ...DEFAULT_VIEW, name: "Kept" }]);
  });
});

function pr(number: number, extra: Partial<TeamPr> = {}): TeamPr {
  return {
    repo: "barry/a",
    number,
    title: `PR ${number}`,
    url: `https://github.test/barry/a/pull/${number}`,
    author: "barry",
    isDraft: false,
    additions: 1,
    deletions: 1,
    comments: 0,
    updatedAt: "2026-07-01T00:00:00Z",
    checks: "none",
    ...extra,
  };
}

function view(extra: Partial<TeamView>): Omit<TeamView, "id" | "name"> {
  return { ...DEFAULT_VIEW, ...extra };
}

describe("applyView", () => {
  test("query matches title, #number, repo, and author, case-insensitively", () => {
    const prs = [pr(1, { title: "Fix login" }), pr(2, { title: "Docs" })];
    expect(applyView(prs, view({ query: "fix" }))).toHaveLength(1);
    expect(applyView(prs, view({ query: "#2" }))).toHaveLength(1);
    expect(applyView(prs, view({ query: "BARRY/A" }))).toHaveLength(2);
    expect(applyView(prs, view({ query: "nobody" }))).toHaveLength(0);
  });

  test("checks, draft, and author filters compose", () => {
    const prs = [
      pr(1, { checks: "failing", isDraft: true }),
      pr(2, { checks: "failing", author: "sam" }),
      pr(3, { checks: "passing" }),
    ];
    expect(applyView(prs, view({ checks: "failing" }))).toHaveLength(2);
    expect(applyView(prs, view({ checks: "failing", draft: "hide" }))).toHaveLength(1);
    expect(applyView(prs, view({ draft: "only" })).map((p) => p.number)).toEqual([1]);
    expect(applyView(prs, view({ author: "SAM" })).map((p) => p.number)).toEqual([2]);
  });

  test("sorts: comments and changes order descending; updated keeps feed order", () => {
    const prs = [
      pr(1, { comments: 1, additions: 100 }),
      pr(2, { comments: 5, additions: 2 }),
      pr(3, { comments: 3, additions: 50 }),
    ];
    expect(applyView(prs, view({ sort: "comments" })).map((p) => p.number)).toEqual([2, 3, 1]);
    expect(applyView(prs, view({ sort: "changes" })).map((p) => p.number)).toEqual([1, 3, 2]);
    expect(applyView(prs, view({ sort: "updated" })).map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

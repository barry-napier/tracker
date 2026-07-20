import { describe, expect, test } from "vitest";
import {
  DEFAULT_PREFS,
  groupProjects,
  restoreHomePrefs,
  sortProjects,
} from "../src/renderer/homePrefs.ts";
import { timeAgo } from "../src/renderer/format.ts";
import type { ProjectListItem } from "../src/server/types.ts";

function item(
  id: number,
  name: string,
  extra: Partial<ProjectListItem> = {},
): ProjectListItem {
  return {
    id,
    name,
    ticketPrefix: "TRK",
    defaultProvider: "claude-code",
    workflowId: 1,
    hiddenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: null,
    repoPath: null,
    ...extra,
  };
}

describe("home prefs persistence", () => {
  test("round-trips through JSON", () => {
    const prefs = {
      sort: "name",
      grouping: "folder",
      visible: 9,
      collapsed: ["/a"],
      showArchived: true,
    } as const;
    expect(restoreHomePrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  test("garbage in, defaults out: malformed JSON or shapes never throw", () => {
    for (const raw of [null, "", "not json", "42", "[]", '{"sort":7}']) {
      expect(restoreHomePrefs(raw)).toEqual(DEFAULT_PREFS);
    }
  });

  test("unknown enum values and wild counts restore to safe defaults", () => {
    const prefs = restoreHomePrefs(
      '{"sort":"chaos","grouping":"vibes","visible":900,"collapsed":["/a",7]}',
    );
    expect(prefs.sort).toBe("activity");
    expect(prefs.grouping).toBe("none");
    expect(prefs.visible).toBe(20); // clamped, not defaulted — the intent was "many"
    expect(prefs.collapsed).toEqual(["/a"]); // non-strings dropped
  });
});

describe("sorting", () => {
  const rows = [
    item(3, "beta", { createdAt: "2026-03-01T00:00:00.000Z" }),
    item(1, "alpha", { createdAt: "2026-05-01T00:00:00.000Z" }),
    item(2, "gamma", { createdAt: "2026-04-01T00:00:00.000Z" }),
  ];

  test("activity keeps the server's order — event ids are the authority", () => {
    expect(sortProjects(rows, "activity").map((p) => p.id)).toEqual([3, 1, 2]);
  });

  test("created sorts newest first", () => {
    expect(sortProjects(rows, "created").map((p) => p.id)).toEqual([1, 2, 3]);
  });

  test("name sorts alphabetically", () => {
    expect(sortProjects(rows, "name").map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("never mutates its input", () => {
    sortProjects(rows, "name");
    expect(rows.map((p) => p.id)).toEqual([3, 1, 2]);
  });
});

describe("grouping", () => {
  const rows = [
    item(1, "tracker", { repoPath: "/Users/b/Developer/tracker" }),
    item(2, "notes", { repoPath: "/Users/b/Personal/notes" }),
    item(3, "reevu", { repoPath: "/Users/b/Developer/reevu" }),
    item(4, "orphan"),
  ];

  test("keep separate yields one headerless group", () => {
    expect(groupProjects(rows, "none")).toEqual([{ key: null, label: null, projects: rows }]);
  });

  test("folder grouping buckets by the checkout's parent directory, in row order", () => {
    const groups = groupProjects(rows, "folder");
    expect(groups.map((g) => g.label)).toEqual(["Developer", "Personal", "no repo"]);
    expect(groups[0]!.key).toBe("/Users/b/Developer");
    expect(groups[0]!.projects.map((p) => p.id)).toEqual([1, 3]);
    expect(groups[2]!.projects.map((p) => p.id)).toEqual([4]); // repo-less bucket trails
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  test.each([
    ["2026-07-20T11:59:40.000Z", "just now"],
    ["2026-07-20T11:34:00.000Z", "26m ago"],
    ["2026-07-20T09:00:00.000Z", "3h ago"],
    ["2026-03-08T12:00:00.000Z", "134d ago"],
    ["2024-07-20T12:00:00.000Z", "2y ago"],
  ])("%s → %s", (iso, label) => {
    expect(timeAgo(iso, now)).toBe(label);
  });
});

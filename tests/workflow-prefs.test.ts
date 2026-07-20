import { describe, expect, test } from "vitest";
import type { WorkflowListing } from "../src/server/types.ts";
import {
  clampWfVisible,
  DEFAULT_WF_PREFS,
  filterWorkflows,
  restoreWorkflowPrefs,
  sortWorkflows,
} from "../src/renderer/workflowPrefs.ts";

function listing(over: Partial<WorkflowListing>): WorkflowListing {
  return {
    id: 1,
    name: "RPIRD",
    description: "",
    color: null,
    icon: null,
    archived: false,
    isDefault: false,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    version: 1,
    phases: ["research", "plan"],
    usedByProjects: 0,
    deletable: true,
    hasDraft: false,
    ...over,
  };
}

describe("workflow prefs: restore", () => {
  test("garbage, wrong types, and null all restore to the defaults", () => {
    expect(restoreWorkflowPrefs(null)).toEqual(DEFAULT_WF_PREFS);
    expect(restoreWorkflowPrefs("not json")).toEqual(DEFAULT_WF_PREFS);
    expect(restoreWorkflowPrefs('"a string"')).toEqual(DEFAULT_WF_PREFS);
    expect(
      restoreWorkflowPrefs('{"sort":"bogus","visible":"nine","showArchived":"yes"}'),
    ).toEqual(DEFAULT_WF_PREFS);
  });

  test("valid fields survive; visible clamps to bounds", () => {
    expect(restoreWorkflowPrefs('{"sort":"usage","visible":99,"showArchived":true}')).toEqual({
      sort: "usage",
      visible: 20,
      showArchived: true,
    });
    expect(clampWfVisible(0)).toBe(1);
    expect(clampWfVisible(7.9)).toBe(7);
  });
});

describe("workflow prefs: filter", () => {
  const rows = [
    listing({ id: 1, name: "RPIRD" }),
    listing({ id: 2, name: "Quick fix", archived: true }),
    listing({ id: 3, name: "Docs", phases: ["research", "document"] }),
  ];

  test("idle list hides archived unless the pref shows them", () => {
    expect(filterWorkflows(rows, "", DEFAULT_WF_PREFS).map((r) => r.id)).toEqual([1, 3]);
    expect(
      filterWorkflows(rows, "", { ...DEFAULT_WF_PREFS, showArchived: true }).map((r) => r.id),
    ).toEqual([1, 2, 3]);
  });

  test("a query sweeps archived rows and matches phase names too", () => {
    expect(filterWorkflows(rows, "quick", DEFAULT_WF_PREFS).map((r) => r.id)).toEqual([2]);
    expect(filterWorkflows(rows, "document", DEFAULT_WF_PREFS).map((r) => r.id)).toEqual([3]);
  });
});

describe("workflow prefs: sort", () => {
  const rows = [
    listing({ id: 1, name: "Zeta", createdAt: "2026-01-01", usedByProjects: 0 }),
    listing({ id: 2, name: "Alpha", createdAt: "2026-03-01", usedByProjects: 2 }),
    listing({ id: 3, name: "Alpha", createdAt: "2026-02-01", usedByProjects: 2 }),
  ];

  test("name: alphabetical, id breaks ties", () => {
    expect(sortWorkflows(rows, "name").map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("created: newest first", () => {
    expect(sortWorkflows(rows, "created").map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("usage: most used first, id breaks ties", () => {
    expect(sortWorkflows(rows, "usage").map((r) => r.id)).toEqual([2, 3, 1]);
  });
});

import { describe, expect, test } from "vitest";
import { restoreTabs, serializeTabs } from "../src/renderer/tabsState.ts";
import type { Project } from "../src/server/types.ts";

function project(id: number, name: string): Project {
  return { id, name, ticketPrefix: "TRK", defaultProvider: "claude-code", workflowId: 1, createdAt: "" };
}

const KNOWN = [project(1, "tracker"), project(2, "reevu"), project(3, "cairn")];

describe("tab persistence model (ticket B)", () => {
  test("round-trips open tabs and the active tab", () => {
    const saved = serializeTabs([KNOWN[1]!, KNOWN[0]!], 1);
    const { tabs, activeId } = restoreTabs(saved, KNOWN);
    expect(tabs.map((t) => t.id)).toEqual([2, 1]); // saved order, not project order
    expect(activeId).toBe(1);
  });

  test("drops tabs whose project no longer exists, and the active id with them", () => {
    const saved = serializeTabs([project(9, "deleted"), KNOWN[2]!], 9);
    const { tabs, activeId } = restoreTabs(saved, KNOWN);
    expect(tabs.map((t) => t.id)).toEqual([3]);
    expect(activeId).toBeNull(); // active pointed at the dropped tab → Home view
  });

  test("rehydrates names from the live project rows, not the saved snapshot", () => {
    const saved = serializeTabs([project(1, "old-name")], null);
    const { tabs } = restoreTabs(saved, KNOWN);
    expect(tabs[0]!.name).toBe("tracker");
  });

  test("garbage in, empty out: malformed JSON or shapes never throw", () => {
    for (const raw of [null, "", "not json", "42", '{"tabIds":"nope"}', '{"tabIds":[{"a":1}]}']) {
      const { tabs, activeId } = restoreTabs(raw, KNOWN);
      expect(tabs).toEqual([]);
      expect(activeId).toBeNull();
    }
  });

  test("duplicated ids in tampered storage restore one tab, never two", () => {
    const { tabs } = restoreTabs('{"tabIds":[1,1,2,1],"activeId":1}', KNOWN);
    expect(tabs.map((t) => t.id)).toEqual([1, 2]);
  });

  test("a saved active id that is open stays active; one that is merely known does not resurrect a tab", () => {
    const saved = serializeTabs([KNOWN[0]!], 2); // active points at a project with no tab
    const { tabs, activeId } = restoreTabs(saved, KNOWN);
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(activeId).toBeNull();
  });
});

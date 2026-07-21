import { afterEach, describe, expect, test } from "vitest";
import { isAutomationDue, nextAutomationRun, parseTimeOfDay } from "../src/server/automation-schedule.ts";
import type { Automation, AutomationTemplate, TicketWithAcs } from "../src/server/types.ts";
import { bootServer, runCleanups } from "./server-helpers.ts";

afterEach(runCleanups);

function automation(extra: Partial<Automation> = {}): Automation {
  return {
    id: 1,
    title: "Find Critical Bugs",
    category: "bugs",
    priority: "high",
    prompt: "hunt",
    cadence: "daily",
    timeOfDay: "09:00",
    dayOfWeek: null,
    projectId: 1,
    provider: null,
    enabled: true,
    lastFiredAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...extra,
  };
}

/** Local-time constructor keeps assertions immune to the machine's zone. */
function local(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("schedule math", () => {
  test("parseTimeOfDay accepts HH:MM and rejects junk", () => {
    expect(parseTimeOfDay("09:30")).toBe(9 * 60 + 30);
    expect(parseTimeOfDay("23:59")).toBe(23 * 60 + 59);
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9am")).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
  });

  test("manual and disabled rows never schedule", () => {
    expect(nextAutomationRun(automation({ cadence: "manual" }), new Date())).toBeNull();
    expect(nextAutomationRun(automation({ enabled: false }), new Date())).toBeNull();
    expect(isAutomationDue(automation({ cadence: "manual" }), new Date())).toBe(false);
  });

  test("daily: next run is today before the slot, tomorrow after it", () => {
    const before = local(2026, 7, 21, 8, 0);
    const after = local(2026, 7, 21, 10, 0);
    expect(nextAutomationRun(automation(), before)).toEqual(local(2026, 7, 21, 9, 0));
    expect(nextAutomationRun(automation(), after)).toEqual(local(2026, 7, 22, 9, 0));
  });

  test("daily: due once past the slot, not after it fired", () => {
    const now = local(2026, 7, 21, 9, 5);
    expect(isAutomationDue(automation(), now)).toBe(true);
    const fired = automation({ lastFiredAt: local(2026, 7, 21, 9, 1).toISOString() });
    expect(isAutomationDue(fired, now)).toBe(false);
    // Next day the same row is due again.
    expect(isAutomationDue(fired, local(2026, 7, 22, 9, 5))).toBe(true);
    // A row created after today's slot owes nothing until tomorrow.
    const young = automation({ createdAt: local(2026, 7, 21, 10, 0).toISOString() });
    expect(isAutomationDue(young, local(2026, 7, 21, 10, 5))).toBe(false);
  });

  test("weekly: fires only on the configured weekday", () => {
    // 2026-07-21 is a Tuesday (day 2); configure Wednesday (3). Last week's
    // Wednesday already fired, so nothing is owed until tomorrow's slot.
    const weekly = automation({
      cadence: "weekly",
      dayOfWeek: 3,
      lastFiredAt: local(2026, 7, 15, 9, 1).toISOString(),
    });
    const tuesday = local(2026, 7, 21, 12, 0);
    expect(nextAutomationRun(weekly, tuesday)).toEqual(local(2026, 7, 22, 9, 0));
    expect(isAutomationDue(weekly, tuesday)).toBe(false);
    expect(isAutomationDue(weekly, local(2026, 7, 22, 9, 30))).toBe(true);
  });

  test("a slot slept through is still due on wake, once", () => {
    // App was closed at 09:00; it is now 18:40 the same day.
    const evening = local(2026, 7, 21, 18, 40);
    expect(isAutomationDue(automation(), evening)).toBe(true);
    const fired = automation({ lastFiredAt: local(2026, 7, 21, 18, 41).toISOString() });
    expect(isAutomationDue(fired, evening)).toBe(false);
  });
});

describe("automations API", () => {
  test("the built-in templates are seeded, all six from v1", async () => {
    const server = await bootServer();
    const res = await fetch(`${server.url}/api/automation-templates`);
    const templates = (await res.json()) as AutomationTemplate[];
    expect(templates.map((t) => t.title)).toEqual([
      "Find Critical Bugs",
      "Architectural Cleanup",
      "Generate Living Documentation",
      "Simplify Code (*simplify)",
      "Fix Snyk Vulnerabilities",
      "Fix SonarQube Issues",
    ]);
  });

  test("templates are user-editable rows: create, patch, delete", async () => {
    const server = await bootServer();
    const created = (await (
      await fetch(`${server.url}/api/automation-templates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Dep audit", prompt: "audit deps", category: "security" }),
      })
    ).json()) as AutomationTemplate;
    expect(created.id).toBeGreaterThan(6);
    expect(created.priority).toBe("medium");

    const patched = (await (
      await fetch(`${server.url}/api/automation-templates/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      })
    ).json()) as AutomationTemplate;
    expect(patched.priority).toBe("high");
    expect(patched.prompt).toBe("audit deps");

    await fetch(`${server.url}/api/automation-templates/${created.id}`, { method: "DELETE" });
    const listed = (await (
      await fetch(`${server.url}/api/automation-templates`)
    ).json()) as AutomationTemplate[];
    expect(listed).toHaveLength(6);

    const missingTitle = await fetch(`${server.url}/api/automation-templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p" }),
    });
    expect(missingTitle.status).toBe(400);
  });

  test("create, list with derived fields, patch, delete", async () => {
    const server = await bootServer();
    const project = (await (
      await fetch(`${server.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "acme" }),
      })
    ).json()) as { id: number };

    const created = (await (
      await fetch(`${server.url}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Nightly bug hunt",
          prompt: "hunt bugs",
          cadence: "daily",
          timeOfDay: "07:30",
          projectId: project.id,
        }),
      })
    ).json()) as Automation;
    expect(created.id).toBeGreaterThan(0);
    expect(created.enabled).toBe(true);

    const listed = (await (
      await fetch(`${server.url}/api/automations`)
    ).json()) as Array<{ projectName: string | null; nextRunAt: string | null }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.projectName).toBe("acme");
    expect(listed[0]!.nextRunAt).not.toBeNull();

    const patched = (await (
      await fetch(`${server.url}/api/automations/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, cadence: "weekly", dayOfWeek: 5 }),
      })
    ).json()) as Automation;
    expect(patched.enabled).toBe(false);
    expect(patched.cadence).toBe("weekly");

    const del = await fetch(`${server.url}/api/automations/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await (await fetch(`${server.url}/api/automations`)).json()).toEqual([]);
  });

  test("bad bodies are refused", async () => {
    const server = await bootServer();
    const missingTitle = await fetch(`${server.url}/api/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(missingTitle.status).toBe(400);
    const badTime = await fetch(`${server.url}/api/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "p", timeOfDay: "25:00" }),
    });
    expect(badTime.status).toBe(400);
    const badCadence = await fetch(`${server.url}/api/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "p", cadence: "hourly" }),
    });
    expect(badCadence.status).toBe(400);
  });

  test("run now creates a ticket; with a repo it lands promoted in todo", async () => {
    const server = await bootServer();
    const project = (await (
      await fetch(`${server.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "acme" }),
      })
    ).json()) as { id: number };
    const auto = (await (
      await fetch(`${server.url}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Bug hunt", prompt: "hunt", projectId: project.id }),
      })
    ).json()) as Automation;

    // No repo yet: the ticket stays in backlog.
    const backlogTicket = (await (
      await fetch(`${server.url}/api/automations/${auto.id}/run`, { method: "POST" })
    ).json()) as TicketWithAcs;
    expect(backlogTicket.state).toBe("backlog");
    expect(backlogTicket.title).toBe("Bug hunt");
    expect(backlogTicket.description).toBe("hunt");

    // With a repo: promoted straight to todo with the project's default agent.
    await fetch(`${server.url}/api/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, path: "/tmp/fake", githubRemote: null }),
    });
    const promoted = (await (
      await fetch(`${server.url}/api/automations/${auto.id}/run`, { method: "POST" })
    ).json()) as TicketWithAcs;
    expect(promoted.state).toBe("todo");
    expect(promoted.provider).toBe("claude-code");

    // lastFiredAt stamped on the row.
    const listed = (await (await fetch(`${server.url}/api/automations`)).json()) as Automation[];
    expect(listed[0]!.lastFiredAt).not.toBeNull();
  });

  test("run now on an unaimed automation is a 409", async () => {
    const server = await bootServer();
    const auto = (await (
      await fetch(`${server.url}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Orphan", prompt: "p" }),
      })
    ).json()) as Automation;
    const res = await fetch(`${server.url}/api/automations/${auto.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

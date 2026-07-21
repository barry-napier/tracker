import { isAutomationDue } from "./automation-schedule.ts";
import type { Store } from "./store.ts";

/**
 * Fires due Automations. A one-minute poll, not a timer per row: dueness is
 * derived from (cadence, timeOfDay, lastFiredAt) each tick, so an app that
 * slept through a slot fires it once on wake instead of missing it, and an
 * edit takes effect on the next tick with nothing to reschedule.
 */
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Catch-up pass at boot: anything that came due while the app was closed.
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; exposed for tests to drive time by hand. */
  tick(now = new Date()): void {
    for (const automation of this.store.listAutomations()) {
      if (!isAutomationDue(automation, now)) continue;
      if (automation.projectId === null) continue;
      try {
        this.store.fireAutomation(automation.id, "agent");
      } catch (error) {
        // One broken row must not stall the rest; the next tick retries only
        // if the slot is still unfired (fireAutomation stamps lastFiredAt).
        console.error(`automation ${automation.id} failed to fire:`, error);
      }
    }
  }
}

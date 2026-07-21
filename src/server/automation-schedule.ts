import type { Automation } from "./types.ts";

/**
 * Pure schedule math for Automations, shared by the store's listing (the
 * "next run" a row shows) and the scheduler's due check. Times are the
 * machine's local wall clock — an operator schedules "07:00" meaning their
 * morning, not UTC's.
 */

/** "HH:MM" → minutes past midnight; null when the string isn't a time. */
export function parseTimeOfDay(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The soonest local Date at `minutes` past midnight on/after `from`'s day. */
function atTime(from: Date, minutes: number): Date {
  const at = new Date(from);
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return at;
}

/**
 * When this automation fires next, judged from `from`: null for manual or
 * disabled rows, or a schedule missing its time. A row that already fired at
 * or past its most recent slot waits for the following one.
 */
export function nextAutomationRun(automation: Automation, from: Date): Date | null {
  if (!automation.enabled || automation.cadence === "manual") return null;
  const minutes = parseTimeOfDay(automation.timeOfDay);
  if (minutes === null) return null;

  const lastFired = automation.lastFiredAt === null ? null : new Date(automation.lastFiredAt);
  if (automation.cadence === "daily") {
    let next = atTime(from, minutes);
    while (next <= from || (lastFired !== null && lastFired >= next)) {
      next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
      // DST: re-pin the wall-clock time after the day arithmetic.
      next = atTime(next, minutes);
    }
    return next;
  }

  // Weekly: walk day by day to the configured weekday (defaulting to
  // Sunday when unset) whose slot is still ahead and unfired.
  const targetDay = automation.dayOfWeek ?? 0;
  let next = atTime(from, minutes);
  for (let i = 0; i < 15; i++) {
    if (next.getDay() === targetDay && next > from && (lastFired === null || lastFired < next)) {
      return next;
    }
    next = atTime(new Date(next.getTime() + 24 * 60 * 60 * 1000), minutes);
  }
  return null;
}

/**
 * Due = the most recent scheduled slot at/before `now` has not fired yet.
 * Derived from nextAutomationRun's complement: the automation is due when
 * pretending it never fired puts its next slot in the past.
 */
export function isAutomationDue(automation: Automation, now: Date): boolean {
  if (!automation.enabled || automation.cadence === "manual") return false;
  const minutes = parseTimeOfDay(automation.timeOfDay);
  if (minutes === null) return false;

  // The most recent slot at or before now.
  let slot = atTime(now, minutes);
  if (automation.cadence === "daily") {
    if (slot > now) slot = atTime(new Date(slot.getTime() - 24 * 60 * 60 * 1000), minutes);
  } else {
    const targetDay = automation.dayOfWeek ?? 0;
    for (let i = 0; i < 15 && (slot.getDay() !== targetDay || slot > now); i++) {
      slot = atTime(new Date(slot.getTime() - 24 * 60 * 60 * 1000), minutes);
    }
    if (slot.getDay() !== targetDay || slot > now) return false;
  }

  // The watermark: the last firing, or creation for a row that never fired —
  // a slot that predates the automation itself was never owed.
  const watermark = new Date(automation.lastFiredAt ?? automation.createdAt);
  return watermark < slot;
}

import type { TicketState } from "../server/types.ts";

/*
 * Per-state column icons, Linear-style: a stroked circle whose interior fills
 * as the ticket advances (empty → quarter → half → three-quarter → check).
 * Colors ride the state ramp tokens so light/dark both work.
 */

const COLORS: Record<TicketState, string> = {
  backlog: "var(--text-faint)",
  todo: "var(--text-muted)",
  in_progress: "var(--warn-fg)",
  verifying: "var(--ok-fg)",
  human_review: "var(--info-fg)",
  done: "var(--text-accent)",
};

/** Pie wedge from 12 o'clock covering `fraction` of a r=3.2 disc centered at 7,7. */
function pie(fraction: number): string {
  const angle = 2 * Math.PI * fraction;
  const x = 7 + 3.2 * Math.sin(angle);
  const y = 7 - 3.2 * Math.cos(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return `M7 7 L7 3.8 A3.2 3.2 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

export function StateIcon({ state }: { state: TicketState }) {
  const color = COLORS[state];
  return (
    <svg className="state-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {state === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M4.5 7.2 L6.2 8.9 L9.6 5.4"
            fill="none"
            stroke="var(--surface-panel)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.4"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
            strokeDasharray={state === "backlog" ? "1.8 2.1" : undefined}
          />
          {state === "in_progress" && <path d={pie(0.25)} fill={color} />}
          {state === "verifying" && <path d={pie(0.5)} fill={color} />}
          {state === "human_review" && <path d={pie(0.75)} fill={color} />}
        </>
      )}
    </svg>
  );
}

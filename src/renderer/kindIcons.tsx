import type { IntakeKind } from "../server/types.ts";

/**
 * Jira-style ticket-type icons: red bug, purple lightning (feature), yellow
 * bulb (large initiative). Hand-drawn on the repo's 16×16 icon grid with
 * 1px currentColor strokes (icons.tsx idiom); the color rides on CSS
 * `--kind-*` tokens so both themes stay legible. A green bookmark (story)
 * is drawn too for the day a story kind exists.
 */

const KIND_PATHS: Record<IntakeKind | "story", React.ReactNode> = {
  bug: (
    <>
      {/* body */}
      <ellipse cx="8" cy="9" rx="3" ry="4" stroke="currentColor" />
      {/* head + antennae */}
      <path d="M6.5 5.4 5.2 3.8M9.5 5.4l1.3-1.6" stroke="currentColor" strokeLinecap="square" />
      {/* legs */}
      <path
        d="M5 7.5 2.8 6.7M5 9.5H2.6M5 11l-2 1.3M11 7.5l2.2-.8M11 9.5h2.4M11 11l2 1.3"
        stroke="currentColor"
        strokeLinecap="square"
      />
      {/* wing split */}
      <path d="M8 5.5v7" stroke="currentColor" />
    </>
  ),
  feature: (
    <path
      d="M9 1.8 3.5 9h3.6l-.9 5.2L11.9 7H8.3L9 1.8Z"
      stroke="currentColor"
      strokeLinejoin="round"
    />
  ),
  initiative: (
    <>
      {/* bulb */}
      <path
        d="M8 2a4 4 0 0 0-2.2 7.3c.5.4.7.9.7 1.4h3c0-.5.2-1 .7-1.4A4 4 0 0 0 8 2Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      {/* base */}
      <path d="M6.7 12.5h2.6M7 14h2" stroke="currentColor" strokeLinecap="square" />
    </>
  ),
  story: (
    <path
      d="M4.5 2.5h7v11L8 10.5 4.5 13.5v-11Z"
      stroke="currentColor"
      strokeLinejoin="round"
    />
  ),
};

export const KIND_LABEL: Record<IntakeKind, string> = {
  bug: "Bug",
  feature: "Feature",
  initiative: "Large initiative",
};

export function KindIcon({
  kind,
  size = 16,
  title,
}: {
  kind: IntakeKind;
  size?: number;
  title?: string;
}) {
  return (
    <svg
      className={`kindicon kindicon-${kind}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label={title ?? KIND_LABEL[kind]}
    >
      <title>{title ?? KIND_LABEL[kind]}</title>
      {KIND_PATHS[kind]}
    </svg>
  );
}

import type { ComponentProps } from "react";

/**
 * oc-2 icon set (opencode packages/ui icon.tsx + v2/components/icon.tsx):
 * 1px currentColor stroke, square caps. Only the icons Tracker uses.
 * v1 icons draw on a 20×20 grid, v2 on 16×16 — hence per-icon viewBoxes.
 */
const VIEWBOXES: Partial<Record<IconName, string>> = {
  "grid-plus": "0 0 16 16",
  "chevron-down": "0 0 16 16",
  "chevron-left": "0 0 16 16",
  "dots-horizontal": "0 0 16 16",
  search: "0 0 16 16",
  "arrows-sort": "0 0 16 16",
  check: "0 0 16 16",
  sparkle: "0 0 16 16",
  bolt: "0 0 16 16",
  globe: "0 0 16 16",
  book: "0 0 16 16",
  folder: "0 0 16 16",
  code: "0 0 16 16",
  play: "0 0 16 16",
  pencil: "0 0 16 16",
  import: "0 0 16 16",
  paperclip: "0 0 16 16",
  mic: "0 0 16 16",
  "arrow-up": "0 0 16 16",
  warning: "0 0 16 16",
  "chat-new": "0 0 16 16",
};

const PATHS = {
  "grid-plus": (
    <path
      d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z"
      stroke="currentColor"
      strokeMiterlimit="10"
      strokeLinecap="square"
    />
  ),
  "folder-add-left": (
    <path
      d="M2.08333 9.58268V2.91602H8.33333L10 5.41602H17.9167V16.2493H8.75M3.75 12.0827V14.5827M3.75 14.5827V17.0827M3.75 14.5827H1.25M3.75 14.5827H6.25"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "close-small": (
    <path d="M6 6L14 14M14 6L6 14" stroke="currentColor" strokeLinecap="square" />
  ),
  "dots-horizontal": (
    <>
      <circle cx="3.5" cy="8" r="0.75" stroke="currentColor" />
      <circle cx="8" cy="8" r="0.75" stroke="currentColor" />
      <circle cx="12.5" cy="8" r="0.75" stroke="currentColor" />
    </>
  ),
  "chevron-down": (
    <path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" strokeLinecap="square" />
  ),
  "chevron-left": (
    <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" strokeLinecap="square" />
  ),
  "arrows-sort": (
    <path
      d="M5 3.5V13M5 13L2.5 10.5M5 13L7.5 10.5M11 12.5V3M11 3L8.5 5.5M11 3L13.5 5.5"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  check: (
    <path d="M2.5 8.5L6 12L13.5 4.5" stroke="currentColor" strokeLinecap="square" />
  ),
  sparkle: (
    <path
      d="M8 1.5L9.6 6.4L14.5 8L9.6 9.6L8 14.5L6.4 9.6L1.5 8L6.4 6.4L8 1.5Z"
      stroke="currentColor"
      strokeLinejoin="round"
    />
  ),
  search: (
    <path
      d="M11.0625 11.0625L14 14M12.5 7.25C12.5 10.1495 10.1495 12.5 7.25 12.5C4.35051 12.5 2 10.1495 2 7.25C2 4.35051 4.35051 2 7.25 2C10.1495 2 12.5 4.35051 12.5 7.25Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "settings-gear": (
    <>
      <path
        d="M7.62516 4.46094L5.05225 3.86719L3.86475 5.05469L4.4585 7.6276L2.0835 9.21094V10.7943L4.4585 12.3776L3.86475 14.9505L5.05225 16.138L7.62516 15.5443L9.2085 17.9193H10.7918L12.3752 15.5443L14.9481 16.138L16.1356 14.9505L15.5418 12.3776L17.9168 10.7943V9.21094L15.5418 7.6276L16.1356 5.05469L14.9481 3.86719L12.3752 4.46094L10.7918 2.08594H9.2085L7.62516 4.46094Z"
        stroke="currentColor"
      />
      <path
        d="M12.5002 10.0026C12.5002 11.3833 11.3809 12.5026 10.0002 12.5026C8.61945 12.5026 7.50016 11.3833 7.50016 10.0026C7.50016 8.62189 8.61945 7.5026 10.0002 7.5026C11.3809 7.5026 12.5002 8.62189 12.5002 10.0026Z"
        stroke="currentColor"
      />
    </>
  ),
  bolt: (
    <path
      d="M9 1.5L3.5 9.5H7L6.5 14.5L12.5 6.5H8.5L9 1.5Z"
      stroke="currentColor"
      strokeLinejoin="bevel"
    />
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" stroke="currentColor" />
      <path d="M2 8H14M8 2C10 4 10 12 8 14C6 12 6 4 8 2Z" stroke="currentColor" strokeLinecap="square" />
    </>
  ),
  book: (
    <path
      d="M8 3.5C6.5 2.5 4 2.5 2.5 3V13C4 12.5 6.5 12.5 8 13.5C9.5 12.5 12 12.5 13.5 13V3C12 2.5 9.5 2.5 8 3.5ZM8 3.5V13.5"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  folder: (
    <path
      d="M2 3.5H6.5L8 5.5H14V12.5H2V3.5Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  code: (
    <path
      d="M5 4.5L1.5 8L5 11.5M11 4.5L14.5 8L11 11.5"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  play: (
    <path d="M4.5 3L12.5 8L4.5 13V3Z" stroke="currentColor" strokeLinejoin="bevel" />
  ),
  pencil: (
    <path
      d="M2.5 13.5L3 11L11.5 2.5L13.5 4.5L5 13L2.5 13.5ZM10.25 3.75L12.25 5.75"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  import: (
    <path
      d="M8 11V2.5M8 11L5 8M8 11L11 8M2 11.5V14H14V11.5"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  paperclip: (
    <path
      d="M12.5 7.5L7.75 12.25C6.64543 13.3546 4.85457 13.3546 3.75 12.25C2.64543 11.1454 2.64543 9.35457 3.75 8.25L8.85 3.15C9.58638 2.41362 10.7803 2.41362 11.5167 3.15C12.253 3.88638 12.253 5.08029 11.5167 5.81667L6.41667 10.9167C6.04848 11.2848 5.45152 11.2848 5.08333 10.9167C4.71514 10.5485 4.71514 9.95152 5.08333 9.58333L9.83333 4.83333"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  mic: (
    <>
      <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" />
      <path d="M3.5 7.5C3.5 10 5.5 11.5 8 11.5C10.5 11.5 12.5 10 12.5 7.5M8 11.5V14.5" stroke="currentColor" strokeLinecap="square" />
    </>
  ),
  "arrow-up": (
    <path d="M8 13.5V2.5M8 2.5L3.5 7M8 2.5L12.5 7" stroke="currentColor" strokeLinecap="square" />
  ),
  warning: (
    <path
      d="M8 1.5L15 14H1L8 1.5ZM8 6V9.5M8 11.25V12"
      stroke="currentColor"
      strokeLinejoin="bevel"
    />
  ),
  "chat-new": (
    <path
      d="M14 8.5V13.5H2V3.5H8M12.5 1.5V6.5M10 4H15"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
} as const;

export type IconName = keyof typeof PATHS;

/** Server-stored icon names are opaque strings; gate them before rendering. */
export function isIconName(name: string): name is IconName {
  return name in PATHS;
}

export function Icon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & ComponentProps<"svg">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOXES[name] ?? "0 0 20 20"}
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

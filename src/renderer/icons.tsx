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
  search: "0 0 16 16",
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
  "chevron-down": (
    <path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" strokeLinecap="square" />
  ),
  "chevron-left": (
    <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" strokeLinecap="square" />
  ),
  search: (
    <path
      d="M11.0625 11.0625L14 14M12.5 7.25C12.5 10.1495 10.1495 12.5 7.25 12.5C4.35051 12.5 2 10.1495 2 7.25C2 4.35051 4.35051 2 7.25 2C10.1495 2 12.5 4.35051 12.5 7.25Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  help: (
    <path
      d="M7.91683 7.91927V6.2526H12.0835V8.7526L10.0002 10.0026V12.0859M10.0002 13.7526V13.7609M17.9168 10.0026C17.9168 14.3749 14.3724 17.9193 10.0002 17.9193C5.62791 17.9193 2.0835 14.3749 2.0835 10.0026C2.0835 5.63035 5.62791 2.08594 10.0002 2.08594C14.3724 2.08594 17.9168 5.63035 17.9168 10.0026Z"
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
} as const;

type IconName = keyof typeof PATHS;

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

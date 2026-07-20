import type { ComponentProps } from "react";

/**
 * oc-2 icon set, vendored from assets/icons/core/icon.tsx (opencode, MIT):
 * 1px currentColor stroke, square caps, 20×20 grid. Only the icons Tracker uses.
 * Icons with no opencode equivalent are hand-drawn on a 16×16 grid — hence
 * the per-icon viewBox overrides.
 */
const VIEWBOXES: Partial<Record<IconName, string>> = {
  "grid-plus": "0 0 16 16",
  "dots-horizontal": "0 0 16 16",
  "dots-vertical": "0 0 16 16",
  refresh: "0 0 16 16",
  "arrows-sort": "0 0 16 16",
  search: "0 0 16 16",
  sparkle: "0 0 16 16",
  "theme-auto": "0 0 16 16",
  sun: "0 0 16 16",
  moon: "0 0 16 16",
  bolt: "0 0 16 16",
  globe: "0 0 16 16",
  book: "0 0 16 16",
  play: "0 0 16 16",
  paperclip: "0 0 16 16",
  mic: "0 0 16 16",
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
  "layout-bottom": (
    <path
      d="M2.91732 2.91602L17.084 2.91602M2.91732 2.91602L2.91732 17.0827M17.084 2.91602L17.084 17.0827M17.084 17.0827L2.91732 17.0827M2.91732 12.0827L17.084 12.0827"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "layout-bottom-partial": (
    <>
      <path
        d="M2.91732 12.0827L17.084 12.0827L17.084 17.0827H2.91732L2.91732 12.0827Z"
        fill="currentColor"
        fillOpacity="16%"
      />
      <path
        d="M2.91732 2.91602L17.084 2.91602M2.91732 2.91602L2.91732 17.0827M17.084 2.91602L17.084 17.0827M17.084 17.0827L2.91732 17.0827M2.91732 12.0827L17.084 12.0827"
        stroke="currentColor"
        strokeLinecap="square"
      />
    </>
  ),
  "split-horizontal": (
    <path
      d="M2.91732 2.91602H17.084V17.0827H2.91732V2.91602ZM10.0007 2.91602V17.0827"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "split-vertical": (
    <path
      d="M2.91732 2.91602H17.084V17.0827H2.91732V2.91602ZM2.91732 9.99935H17.084"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "plus-small": (
    <path
      d="M9.99984 5.41699V10.0003M9.99984 10.0003V14.5837M9.99984 10.0003H5.4165M9.99984 10.0003H14.5832"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  trash: (
    <path
      d="M4.58342 17.9134L4.58369 17.4134L4.22787 17.5384L4.22766 18.0384H4.58342V17.9134ZM15.4167 17.9134V18.0384H15.7725L15.7723 17.5384L15.4167 17.9134ZM2.08342 3.95508V3.45508H1.58342V3.95508H2.08342V4.45508V3.95508ZM17.9167 4.45508V4.95508H18.4167V4.45508H17.9167V3.95508V4.45508ZM4.16677 4.58008L3.66701 4.5996L4.22816 17.5379L4.72792 17.4934L5.22767 17.4489L4.66652 4.54055L4.16677 4.58008ZM4.58342 18.0384V17.9134H15.4167V18.0384V18.5384H4.58342V18.0384ZM15.4167 17.9134L15.8332 17.5379L16.2498 4.5996L15.7501 4.58008L15.2503 4.56055L14.8337 17.4989L15.4167 17.9134ZM15.8334 4.58008V4.08008H4.16677V4.58008V5.08008H15.8334V4.58008ZM2.08342 4.45508V4.95508H4.16677V4.58008V4.08008H2.08342V4.45508ZM15.8334 4.58008V5.08008H17.9167V4.45508V3.95508H15.8334V4.58008ZM6.83951 4.35149L7.432 4.55047C7.79251 3.47701 8.80699 2.70508 10.0001 2.70508V2.20508V1.70508C8.25392 1.70508 6.77335 2.83539 6.24702 4.15251L6.83951 4.35149ZM10.0001 2.20508V2.70508C11.1932 2.70508 12.2077 3.47701 12.5682 4.55047L13.1607 4.35149L13.7532 4.15251C13.2269 2.83539 11.7463 1.70508 10.0001 1.70508V2.20508Z"
      fill="currentColor"
    />
  ),
  "layout-right": (
    <path
      d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z"
      fill="currentColor"
    />
  ),
  "layout-right-partial": (
    <>
      <path
        d="M17.082 17.0807L6.9987 17.0807V2.91406H17.082V17.0807Z"
        fill="currentColor"
        fillOpacity="16%"
      />
      <path
        d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z"
        fill="currentColor"
      />
    </>
  ),
  terminal: (
    <path
      d="M6.5 8L8.64286 10L6.5 12M10.9286 12H13.5M2 18H18V2H2V18Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  copy: (
    <path
      d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z"
      stroke="currentColor"
      strokeLinecap="round"
    />
  ),
  review: (
    <path
      d="M7 14.5H13M7 7.99512H10.0049M10.0049 7.99512H13M10.0049 7.99512V5M10.0049 7.99512V11M18 18V2L2 2L2 18H18Z"
      stroke="currentColor"
    />
  ),
  "chevron-down": (
    <path
      d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "chevron-left": (
    <path d="M12 15L7 10L12 5" stroke="currentColor" strokeLinecap="square" />
  ),
  "chevron-right": (
    <path d="M8 15L13 10L8 5" stroke="currentColor" strokeLinecap="square" />
  ),
  refresh: (
    <path
      d="M13.5 8A5.5 5.5 0 1 1 12 4.25M13.5 2.75V4.9H11.35"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "dots-vertical": (
    <>
      <circle cx="8" cy="3.5" r="0.75" stroke="currentColor" />
      <circle cx="8" cy="8" r="0.75" stroke="currentColor" />
      <circle cx="8" cy="12.5" r="0.75" stroke="currentColor" />
    </>
  ),
  "arrows-sort": (
    <path
      d="M5 3.5V13M5 13L2.5 10.5M5 13L7.5 10.5M11 12.5V3M11 3L8.5 5.5M11 3L13.5 5.5"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  check: (
    <path
      d="M5 11.9657L8.37838 14.7529L15 5.83398"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "theme-auto": (
    <>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" />
      <path d="M8 2.5A5.5 5.5 0 0 0 8 13.5Z" fill="currentColor" />
    </>
  ),
  sun: (
    <path
      d="M8 1.5V3M8 13V14.5M14.5 8H13M3 8H1.5M12.6 3.4L11.5 4.5M4.5 11.5L3.4 12.6M12.6 12.6L11.5 11.5M4.5 4.5L3.4 3.4M11 8C11 9.65685 9.65685 11 8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5C9.65685 5 11 6.34315 11 8Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  moon: (
    <path
      d="M13.5 9.5C12.8 9.8 12 10 11.2 10C7.9 10 6 8.1 6 4.8C6 4 6.2 3.2 6.5 2.5C4.2 3.2 2.5 5.4 2.5 8C2.5 11 5 13.5 8 13.5C10.6 13.5 12.8 11.8 13.5 9.5Z"
      stroke="currentColor"
      strokeLinejoin="round"
    />
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
      d="M13 13L10.6418 10.6418M11.9552 7.47761C11.9552 9.95053 9.95053 11.9552 7.47761 11.9552C5.0047 11.9552 3 9.95053 3 7.47761C3 5.0047 5.0047 3 7.47761 3C9.95053 3 11.9552 5.0047 11.9552 7.47761Z"
      stroke="currentColor"
      strokeLinecap="square"
      vectorEffect="non-scaling-stroke"
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
      <path
        d="M2 8H14M8 2C10 4 10 12 8 14C6 12 6 4 8 2Z"
        stroke="currentColor"
        strokeLinecap="square"
      />
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
      d="M2.08301 2.91675V16.2501H17.9163V5.41675H9.99967L8.33301 2.91675H2.08301Z"
      stroke="currentColor"
      strokeLinecap="round"
    />
  ),
  code: (
    <path
      d="M8.7513 7.5013L6.2513 10.0013L8.7513 12.5013M11.2513 7.5013L13.7513 10.0013L11.2513 12.5013M2.91797 2.91797H17.0846V17.0846H2.91797V2.91797Z"
      stroke="currentColor"
    />
  ),
  play: (
    <path d="M4.5 3L12.5 8L4.5 13V3Z" stroke="currentColor" strokeLinejoin="bevel" />
  ),
  pencil: (
    <path
      d="M9.58301 17.9166H17.9163M17.9163 5.83325L14.1663 2.08325L2.08301 14.1666V17.9166H5.83301L17.9163 5.83325Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  import: (
    <path
      d="M13.9583 10.6257L10 14.584L6.04167 10.6257M10 2.08398V13.959M16.25 17.9173H3.75"
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
      <path
        d="M3.5 7.5C3.5 10 5.5 11.5 8 11.5C10.5 11.5 12.5 10 12.5 7.5M8 11.5V14.5"
        stroke="currentColor"
        strokeLinecap="square"
      />
    </>
  ),
  "arrow-up": (
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.99991 2.24121L16.0921 8.33343L15.2083 9.21731L10.6249 4.63397V17.5001H9.37492V4.63398L4.7916 9.21731L3.90771 8.33343L9.99991 2.24121Z"
      fill="currentColor"
    />
  ),
  warning: (
    <path
      d="M10 7.91667V11.6667M10 13.7417V13.75M10 2.5L1.875 16.25H18.125L10 2.5Z"
      stroke="currentColor"
      strokeLinecap="square"
    />
  ),
  "chat-new": (
    <path
      d="M12 2H2V18H18V8M6 11.3818V14H8.61818L18 4.61818L15.3818 2L6 11.3818Z"
      stroke="currentColor"
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

# icons

Pulled from https://github.com/sst/opencode (packages/ui + packages/desktop), 2026-07-20.

- `core/icon.tsx` — the main UI icon set (~97 icons) as inline 20x20 SVG paths, `currentColor`, Solid component. Easiest source to steal individual glyphs from.
- `raw-app/`, `raw-file-types/`, `raw-provider/` — raw SVG/PNG assets: editor/terminal app icons (16), file-type icons (1089), AI provider icons (105).
- `app-icons/`, `file-icons/`, `provider-icons/` — the same sets compiled into `sprite.svg` + `types.ts` (symbol sprites, used via `<use href>`).
- `desktop/` — app bundle icons (dev/beta/prod × icns/ico/png).
- `favicon/` — SVG favicons.

License: MIT (opencode).

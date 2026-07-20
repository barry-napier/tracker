# E2E-1 Research: Machine-readable widget list

## Repo state
- Branch `feat/e2e-1-machine-readable-widget-list`, clean, even with `origin/main` (a6b5225).
- Only two tracked files, both at repo root:
  - `widget.txt` — 11 bytes, exactly one non-empty line: `the widget` (LF-terminated, no BOM, no trailing blank lines).
  - `README.md` — one line: `# gh-proof scratch`.
- No build system, package manifest, CI config, tests, or existing JSON files. Nothing generates or consumes `widget.txt` today.

## Where the work lands
- **New file** `widgets.json` at repo root. Content derived from `widget.txt`: JSON array of non-empty lines in order. For current input that is exactly:
  ```json
  ["the widget"]
  ```
- **Edit** `README.md`: add a section documenting `widgets.json` — what it contains (widget names as a JSON array of strings) and that it derives from `widget.txt` (same names, same order). Keep the existing `# gh-proof scratch` heading.

## Acceptance-criteria mapping
- AC-1: satisfied by creating `widgets.json` with the array above; verify with `python3 -c "import json; print(json.load(open('widgets.json')))"` or `jq` and compare against non-empty lines of `widget.txt`.
- AC-2: satisfied by the README section; must explicitly mention both the content and the derivation from `widget.txt`.

## Risks / notes
- **Drift**: `widgets.json` is a hand-materialized derivative; if `widget.txt` changes, the JSON goes stale. No tooling exists to regenerate it. Ticket doesn't ask for a generator script — don't gold-plate; a README sentence noting the derivation covers the contract.
- **Line filtering**: AC-1 says "non-empty lines". Current file has none that are empty, but the transform should conceptually skip blanks (relevant only if widget.txt grows).
- **Formatting**: no lint/format config in repo, so JSON style is unconstrained. A trailing newline at EOF matches the style of the two existing files.
- **Ordering**: single entry today, so ordering bugs can't surface in review — the implementation should still read lines sequentially rather than sorting.
- No hidden consumers to break: grep-level sweep is trivial here (two files); nothing references `widgets.json` yet.

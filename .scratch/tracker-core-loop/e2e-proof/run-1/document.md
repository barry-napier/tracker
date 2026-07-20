# E2E-1: Machine-readable widget list — documentation

## What changed

Single commit `b7ac1b9` ("E2E-1: add widgets.json and document it in README"), +7 lines, no deletions:

- **`widgets.json`** (new, repo root) — `["the widget"]`. A JSON array of strings holding the non-empty lines of `widget.txt`, in the same order. With the current one-line `widget.txt`, that's a single-element array.
- **`README.md`** (+6) — new `## widgets.json` section stating what the file contains (a JSON array of widget names), that it derives from the non-empty lines of `widget.txt` in order, and that there is no generator script — regeneration is manual.

`widget.txt` itself is untouched.

## Why

The ticket asked for a machine-readable counterpart to `widget.txt` (one widget name per line) so tooling can consume the list as JSON, plus README documentation of what the file is and where it comes from.

## Acceptance criteria

- **AC-1 — pass.** Verified by parsing: `json.load("widgets.json")` returns a list of strings equal to the non-empty lines of `widget.txt` (`["the widget"]`), same order.
- **AC-2 — pass.** README's `## widgets.json` section documents both contents and derivation from `widget.txt`.

## What to review

1. `widgets.json` entries match `widget.txt`'s non-empty lines exactly (content and order) — currently just `"the widget"`.
2. README wording is accurate against the shipped file.
3. Known trade-off: no generator script, so the two files can drift; the README discloses this and instructs manual regeneration. Decide if that's acceptable or if a follow-up (script/CI check) is wanted.
4. Diff scope is limited to `widgets.json` and `README.md`.

See `kb/recap.html` for the visual recap.

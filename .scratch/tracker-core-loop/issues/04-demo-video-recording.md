# Research: demo-video recording options for CLI agents

Type: research
Status: resolved

## Question

How can a headless CLI agent produce a demo/verification video of a running app? Survey primary sources for viable mechanisms: Playwright video recording + traces (web apps), Electron-app capture options, macOS `screencapture -v` / ScreenKit, ffmpeg screen capture, and anything the agent can drive itself from a worktree. For each: what it can capture, output format, whether it works unattended, and rough integration cost. The prototype exposes a `tracker video-link` attach command — recommend a v1 mechanism that satisfies the `demo-fresh` evidence gate and the review wizard's video step.

## Answer

Full findings: `docs/research/demo-video-recording.md` on branch `research/demo-video-recording` (commit 2e36652).

- **Recommended v1:** a per-ticket `demo.spec` driven by Playwright — `recordVideo` + trace. For Electron targets, `_electron.launch({ recordVideo })` records each BrowserWindow via CDP screencast; for web targets, standard Playwright browser contexts. WebM output plays natively in the Chromium-based review wizard; local ffmpeg handles mp4 conversion if wanted.
- **Why:** CDP screencast needs no macOS Screen Recording (TCC) permission — the only truly unattended option. Traces (filmstrip + DOM snapshots + network) come nearly free in the same run.
- **Disqualified:** `screencapture -v` and ffmpeg/avfoundation capture the whole display and sit behind TCC; macOS Sequoia adds periodic re-authorization prompts that can't be disabled without MDM — fatal for a hands-off `demo-fresh` gate.
- **Fallbacks:** raw CDP `Page.startScreencast` + ffmpeg stitching, or in-app `webContents.capturePage()` loops — TCC-free, medium cost. Microsoft's Playwright agent CLI (`video-start`/`video-chapter`/`video-stop`) is purpose-built for agent session recording.
- **Caveats:** Electron recording isn't headless (needs a logged-in GUI session — fine on a dev Mac); native dialogs/OS chrome aren't captured (stub via `electronApp.evaluate()`); video only flushes on `context.close()`.

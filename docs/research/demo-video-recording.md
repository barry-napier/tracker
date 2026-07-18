# Research: Unattended demo/verification video recording on macOS

**Ticket:** `.scratch/tracker-core-loop/issues/04-demo-video-recording.md`
**Question:** How can a headless CLI coding agent produce a demo/verification video of a running app, unattended, on macOS — feeding a `demo-fresh` evidence gate whose videos are rendered later in a review wizard?

**Context constraints:**

- The orchestrator is an Electron app; agent work happens in git worktrees driven by a CLI agent with no human at the keyboard.
- "Unattended" means: no GUI permission prompt on *any* run, not just after a one-time setup — a TCC dialog mid-run kills the pipeline.
- The artifact must be a playable video file the review wizard can embed (`<video>` tag friendly: webm or mp4).

**Local environment checked:** `ffmpeg` present at `/opt/homebrew/bin/ffmpeg`; Playwright CLI resolves via `npx playwright` (v1.61.1 reported in this worktree). The app under test is Electron ^37 (`package.json`).

---

## (a) Playwright video recording + trace viewer (web apps)

**What it captures.** Page content of a browser context — every page in the context is recorded. Enabled in the test runner via the `video` config option (`'off' | 'on' | 'retain-on-failure' | 'on-first-retry'`), or in library mode via `recordVideo: { dir, size }` on `browser.newContext()` / `launchPersistentContext`. Optional `showActions` overlays highlight each action (element outline + title) directly in the video. ([Videos docs](https://playwright.dev/docs/videos), [BrowserType API](https://playwright.dev/docs/api/class-browsertype))

**Output format.** WebM (VP8). The Playwright docs don't name the codec on the videos page, but the official Playwright agent-CLI docs state sessions are "saved as WebM files" ([agent CLI video recording](https://playwright.dev/agent-cli/commands/video-recording)), and third-party tooling exists specifically because the built-in output is low-bitrate VP8 webm ([playwright-recorder-plus](https://github.com/MuTsunTsai/playwright-recorder-plus)). Default size scales to fit 800×800 (test runner) / 800×450 (context default); set `size` = viewport for crisp output. ([Videos docs](https://playwright.dev/docs/videos))

**Key mechanics/gotchas.** The video file is only written when the browser context closes — you must `await context.close()` before reading `page.video().path()` or calling `video.saveAs()`. ([Videos docs](https://playwright.dev/docs/videos), [Video class](https://playwright.dev/docs/api/class-video))

**Unattended?** Yes, fully. Recording is done in-process from browser compositor frames (CDP screencast) and encoded with Playwright's bundled ffmpeg — no OS screen capture, therefore no macOS Screen Recording (TCC) permission, no prompts, works headless. This is the only class of option here with zero TCC surface.

**Trace viewer (complementary, not a video).** Traces (`trace: 'on' | 'retain-on-failure' | ...`, or `browserContext.tracing` in library mode) produce a `.zip` containing a screencast rendered as a film strip, before/during/after DOM snapshots per action, the action log with timing, network requests/responses, and console output; opened with `npx playwright show-trace trace.zip` or [trace.playwright.dev](https://trace.playwright.dev). ([Trace viewer docs](https://playwright.dev/docs/trace-viewer)) A trace is richer evidence than a video for *verification* (you can inspect DOM state), but it isn't a standalone playable file — the review wizard would need to shell out to the trace viewer. Cheap to record alongside video; worth capturing both.

**Bonus: Playwright agent CLI.** Microsoft ships an agent-facing CLI with `video-start [filename]`, `video-chapter <title> [--description --duration]`, and `video-stop`; auto-record via config or `PLAYWRIGHT_MCP_SAVE_VIDEO`. Output is WebM with chapter markers — purpose-built for "record agent sessions for review." ([agent CLI video recording](https://playwright.dev/agent-cli/commands/video-recording), [playwright-cli repo](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/video-recording.md))

**Integration cost.** Low. `npm i -D playwright` (or `@playwright/test`), a ~30-line driver script per demo, no system config.

---

## (b) Electron apps under Playwright

**Support status.** Playwright has *experimental* Electron support via `const { _electron } = require('playwright')` → `electron.launch({ args: ['.'] })`. It attaches over CDP to the real Electron binary: `firstWindow()` returns a `Page` for the first BrowserWindow, `electronApp.evaluate()` runs code in the **main process** (app object, dialog stubbing, etc.), and `electronApp.context()` returns the BrowserContext for all windows. Supported for Electron v14+ (v37 in this repo is fine). ([Electron class docs](https://playwright.dev/docs/api/class-electron))

**Video + trace.** `electron.launch()` accepts `recordVideo` (and `recordHar`, `tracesDir`) directly — the same webm-per-page recording as (a), and tracing works via `electronApp.context().tracing`. ([Electron class docs](https://playwright.dev/docs/api/class-electron))

**What it captures.** Each BrowserWindow's web contents — i.e. the app UI as rendered, regardless of whether the window is occluded, offscreen, or on a Mac nobody is looking at. It does *not* capture native chrome (traffic-light buttons, native menus, native dialogs).

**Unattended?** Yes, with one caveat: Electron itself is not headless — `electron.launch` opens real windows, so a logged-in GUI session must exist (true on a dev Mac; not true on a bare SSH-only CI box). No TCC prompt is involved because capture is via CDP screencast, not screen recording. Known limitations from the docs: native dialogs (`dialog.showOpenDialog` etc.) can't be intercepted — stub them via `electronApp.evaluate()`; and the app's `nodeCliInspect` fuse must not be disabled or launch times out. ([Electron class docs](https://playwright.dev/docs/api/class-electron))

**Integration cost.** Low-medium. Same dependency as (a); each feature ticket's demo is a small script: `_electron.launch({ args: ['.'], recordVideo: { dir } })` → drive the UI → `await electronApp.close()` → collect webm. Worktree-friendly: launch args point at the worktree's `src/main.mjs`.

---

## (c) macOS `screencapture -v`

**What it captures.** The physical display (whole screen), as seen by the window server — including every other window on the machine. `-v` records video; `-V <seconds>` bounds the duration; `-C` captures the cursor; `-T` delays start. ([screencapture man page](https://ss64.com/mac/screencapture.html))

**Output format.** QuickTime `.mov` (H.264). Playable by the review wizard only after conversion or with mp4 remux.

**Unattended?** Effectively no — this is the deal-breaker:

- Screen capture is TCC-gated: the *responsible process* (Terminal/iTerm/the Electron orchestrator, not `screencapture` itself) must be granted Screen & System Audio Recording in System Settings → Privacy & Security; apps cannot grant it to themselves — the user must toggle it or an MDM profile must pre-authorize it. ([Apple: Control access to screen and audio recording](https://support.apple.com/guide/mac-help/control-access-to-screen-and-audio-recording-mchld6aa7d23/mac))
- Since macOS 15 Sequoia, apps that "bypass the system private window picker and directly access the screen" get **recurring re-authorization prompts** (weekly in betas, then monthly; behavior has shifted across point releases and cannot be permanently disabled by users or developers — only MDM pre-authorization or hacking the TCC-protected `ScreenCaptureApprovals.plist` suppresses it). ([mjtsai roundup](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/), [9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/), [tinyapps workaround](https://tinyapps.org/blog/202409180700_disable_sequoia_nag.html)) So even after one-time setup, a prompt *will* eventually reappear mid-pipeline.
- Over SSH it requires launching inside the loginwindow bootstrap context via `sudo launchctl bsexec`. ([man page](https://ss64.com/mac/screencapture.html))
- Captures the whole screen, so the video includes whatever else the user is doing — bad evidence hygiene and a privacy problem for an always-on orchestrator.

**Integration cost.** Trivial command, but high operational cost (TCC setup per machine, recurring Sequoia prompts, full-screen capture, .mov conversion). Not viable as the primary mechanism.

---

## (d) ffmpeg AVFoundation screen capture

**What it captures.** AVFoundation is Apple's capture framework; ffmpeg's `avfoundation` input device captures cameras and **screen devices** ("Capture screen N" entries in `-list_devices true`). Options: `-framerate`, `-pixel_format`, `-video_size`, `-capture_cursor`, `-capture_mouse_clicks`. Example: `ffmpeg -f avfoundation -list_devices true -i ""` then `ffmpeg -f avfoundation -framerate 30 -i "1:none" out.mp4`. ([ffmpeg-devices docs](https://ffmpeg.org/ffmpeg-devices.html))

**Output format.** Anything ffmpeg encodes — mp4/H.264 or webm directly, which is nicer than screencapture's .mov.

**Unattended?** Same TCC story as (c): screen-device capture goes through the same Screen Recording permission on the responsible process, with the same Sequoia periodic re-approval problem, and the same whole-display scope. ([Apple TCC doc](https://support.apple.com/guide/mac-help/control-access-to-screen-and-audio-recording-mchld6aa7d23/mac), [mjtsai](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/)) ffmpeg is already installed locally, but the permission surface makes it a fallback, not a default.

**Integration cost.** Low code cost (one command, already installed), high operational cost (identical TCC issues to (c)).

---

## (e) Other credible agent-drivable mechanisms

- **Raw CDP screencast.** `Page.startScreencast` (experimental) streams `Page.screencastFrame` events — base64 JPEG/PNG frames with metadata (device dimensions, scroll offset, timestamp); parameters: `format`, `quality`, `maxWidth/maxHeight`, `everyNthFrame`. ([CDP Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)) Works against Electron via `--remote-debugging-port`. No TCC. You must stitch frames to video yourself (ffmpeg image2pipe) — this is essentially what Playwright's recordVideo already does for you, so hand-rolling it only makes sense to avoid the Playwright dependency. Cost: medium.
- **In-app capture (Electron-native).** The app itself can screenshot its window with `webContents.capturePage()` in a loop (no TCC — it's the app's own content), or use `desktopCapturer`/getDisplayMedia + MediaRecorder (screen sources *do* hit TCC on macOS). Frame-loop + ffmpeg stitching works unattended but is bespoke plumbing with worse frame pacing than CDP screencast. Cost: medium, and it couples demo tooling into app code.
- **Playwright trace as the evidence artifact** instead of (or alongside) video — see (a). Strongest for verification, weakest for "watch a demo" UX.
- **Screenshot sequence** (`page.screenshot()` at key steps) stitched by ffmpeg into a slideshow mp4 — degenerate but bulletproof fallback; zero new dependencies beyond (a).

---

## Comparison

| Mechanism | Captures | Format | Truly unattended on macOS | Integration cost |
|---|---|---|---|---|
| Playwright `recordVideo` (web) | Browser page content | webm (VP8) | Yes — no TCC, headless OK | Low |
| Playwright `_electron` + `recordVideo` | Each BrowserWindow's contents | webm | Yes (needs a GUI login session, no prompts) | Low-medium |
| Playwright trace | Filmstrip + DOM snapshots + network + console | .zip (trace) | Yes | Low (add-on) |
| `screencapture -v` | Whole physical display | .mov | No — TCC grant + Sequoia periodic re-prompts | Trivial cmd, high ops |
| ffmpeg avfoundation | Whole display (or camera) | mp4/webm/any | No — same TCC as above | Low code, high ops |
| Raw CDP `startScreencast` | Page frames (JPEG/PNG stream) | roll-your-own | Yes | Medium |
| In-app `capturePage` loop | Own window | roll-your-own | Yes | Medium, invasive |

---

## Recommended v1 mechanism

**Playwright's experimental Electron driver with `recordVideo`, plus a trace, produced by a small `demo.spec` script the agent writes per feature ticket.**

Rationale:

1. **It is the only option that is genuinely unattended on macOS.** Everything OS-level (`screencapture`, ffmpeg/avfoundation) sits behind Screen Recording TCC, which requires a manual System Settings grant per responsible process and — on Sequoia — periodically re-prompts by design, with no user/developer-accessible off switch ([Apple](https://support.apple.com/guide/mac-help/control-access-to-screen-and-audio-recording-mchld6aa7d23/mac), [mjtsai](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/)). A `demo-fresh` gate that can stall on a GUI dialog is not a gate, it's a pager.
2. **It matches the target app.** Tracker is Electron ^37; `electron.launch({ args: [worktreePath], recordVideo })` records exactly the app windows — not the user's screen — which is both better evidence and better privacy ([Electron class docs](https://playwright.dev/docs/api/class-electron)).
3. **Right output for the review wizard.** WebM plays natively in a `<video>` tag inside the (Chromium-based) wizard; no transcode step. If mp4 is ever needed, the locally installed ffmpeg converts in one line.
4. **Worktree-friendly and cheap.** One devDependency; the demo script lives in the worktree, launches the worktree's own `src/main.mjs`, drives the flow, and `await electronApp.close()` flushes the video ([Video class](https://playwright.dev/docs/api/class-video)). Record a trace in the same run for near-free forensic depth ([trace viewer](https://playwright.dev/docs/trace-viewer)).

Accepted risks / mitigations:

- *Experimental API*: the Electron driver is labeled experimental; pin the Playwright version and keep the demo-runner interface thin so it can be swapped.
- *No native chrome/dialogs in frame*: acceptable for feature evidence; stub native dialogs via `electronApp.evaluate()` as the docs prescribe.
- *Needs a GUI session*: fine for the v1 "runs on Barry's Mac" model; revisit (CDP screencast under Xvfb on Linux CI) if the gate ever moves to headless CI.

Fallback order if the Electron driver breaks on a future Electron release: raw CDP screencast via `--remote-debugging-port` + ffmpeg stitching (e), then screenshot-sequence slideshow (e), and only as a last resort TCC-gated ffmpeg/avfoundation (d) with an MDM-style one-machine pre-authorization.

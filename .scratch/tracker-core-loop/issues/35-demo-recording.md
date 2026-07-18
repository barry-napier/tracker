# 35 — Demo recording

**What to build:** During the run, the orchestrator boots the ticket's preview and records the demo against it (per the [demo-video research](04-demo-video-recording.md)): a per-ticket Playwright demo spec with `recordVideo` + `baseURL` for `ui` repos, an agent-authored curl script whose transcript is the demo artifact for `api` repos. The `demo-fresh` gate goes real (demo artifact newer than the last code commit on the branch; skip for non-user-facing ticket types). The wizard's Manual Walkthrough shows the demo video/transcript.

**Blocked by:** 34 — PreviewManager.

**Status:** ready-for-agent

- [ ] Demo recorded against the preview during the run; artifact row persisted (video or transcript by repo kind)
- [ ] `demo-fresh` passes for a fresh demo, fails for a stale one, skips by ticket type — proven with FakeProvider scripts
- [ ] Wizard walkthrough step plays/shows the demo artifact
- [ ] A failed preview boot fails the demo step honestly (no silent skip)

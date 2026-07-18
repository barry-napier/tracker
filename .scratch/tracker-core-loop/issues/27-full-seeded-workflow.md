# 27 — Full seeded workflow with Phase Contract handoff

**What to build:** The seeded default workflow — trigger → research → plan → implement → dogfood → document — as seed data (dogfood behaves as a plain scripted phase until slice 36). Each phase runs in a fresh session and receives the engine's fixed template variable set (ticket fields, ACs with statuses, target branch, prior phases' `kb/` paths). At the end of every Run — pass, bounce, or crash — `kb/*` is persisted to app data with artifact rows recording the worktree HEAD SHA at persist time; the drawer's artifacts section lists them.

**Blocked by:** 26 — FakeProvider runs one phase.

**Status:** ready-for-agent

- [ ] Five-phase seed graph in the store; interpreter walks it end to end with FakeProvider
- [ ] Fixed template variable set is the only context injection; later phases can read earlier `kb/` files
- [ ] Phase executions recorded per node with outcome and provider session id
- [ ] `kb/*` copied to per-run artifact storage on every run end regardless of outcome; artifact rows carry kind, content hash, and worktree HEAD SHA
- [ ] Drawer lists a completed Run's artifacts; Ticket reaches Verifying

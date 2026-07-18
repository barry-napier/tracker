# Implement the store: SQLite schema, migrations, audit trail

Type: task
Status: closed (superseded)

## Question

Build the persistence layer per [Domain model and SQLite schema](05-domain-model-sqlite-schema.md): SQLite in Tracker's app data, migrations, tables for Project/Repo/Ticket/AC rows (pending/verified/failed/waived + provenance)/Run/gate results/workflow graphs (nodes + edges per ADR-0001)/provider config, the append-only Audit Trail event log, and blob-pointer storage (artifacts on disk, DB holds paths). Native `TRK-<n>` id allocation per ADR-0002. Done when the schema round-trips the seeded default workflow graph and a synthetic ticket lifecycle (promote → claim → phases → gates → bounce → re-run → done) writes a coherent audit trail.

Constraint from [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) (2026-07-18): artifact rows carry the worktree HEAD SHA at persist time (wizard staleness compare); repo config gains an optional `persona` field (path to a markdown persona file, like preview config); the gate roster includes the seventh gate `dogfood-green`; the seeded workflow graph's fourth node is `dogfood` (not `review`).

## Superseded (2026-07-18)

Superseded by the vertical-slice breakdown from [the spec](21-core-loop-spec.md): the store skeleton is [22](22-headless-skeleton.md); the remaining tables/columns land inside the slices that need them (25–31, 34). Constraints in this body were folded into those tickets.

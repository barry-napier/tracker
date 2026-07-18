# Tracker owns ticket identity; external trackers are references

Tickets get an immutable native key at creation (per-project prefix + counter, e.g. `TRK-12`) that leaks into branch names, worktrees, and PR titles. Jira/Linear/GitHub-issue links are optional `external_ref` fields, never the ticket's identity — the prototype used the external key as the primary key, so promotion renamed the ticket (`DRAFT-26` → `AS-566`) and everything keyed off it. External-tracker sync itself is a future effort; this decision just keeps the door open without a migration.

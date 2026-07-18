# Provider abstraction interface

Type: grilling
Status: open
Blocked by: 01, 02, 03

## Question

What is the provider interface that Claude Code, Kiro CLI, and Copilot CLI all implement, with room for future providers? Informed by the three research tickets: spawn contract (binary, args, cwd, env), prompt delivery, streaming output/event parsing for the UI's agent-logs view, completion/failure detection, session resume across phases (if the workflow engine wants it), unattended-permission configuration per provider, and capability flags for gaps (e.g. a provider without structured output). Also: how a ticket gets assigned a provider (per-ticket picker as in the prototype's properties panel).

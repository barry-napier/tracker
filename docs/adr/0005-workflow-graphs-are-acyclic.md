# Published workflow graphs are acyclic

The builder's reference UI (Lindy) allows loops, and ours refuses them at publish: retry-shaped intent ("review found problems → go fix them") already exists as the bounce cycle, which is orchestrator-owned, capped at three, and escapes to Human Review. An in-graph loop would be a second retry mechanism with none of those properties — uncapped, invisible to the governor, and resolved by an agent instead of the orchestrator. Acyclic graphs also bound every Run: at most one execution per node.

Considered: cycles with an engine-enforced per-node visit cap (rejected — two retry loops with different teeth, and long runs become undiagnosable); unrestricted cycles (rejected outright).

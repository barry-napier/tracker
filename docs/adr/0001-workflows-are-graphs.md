# Workflows are stored as graphs, not ordered phase lists

The v1 engine only ever runs one linear workflow (trigger → research → plan → implement → review → document), so an `order` column would be the obvious schema. We store nodes + edges anyway (`workflow_nodes`, `workflow_edges` with a nullable condition label on the edge), because the planned workflow builder is a Lindy-style node-graph editor — labeled branches, multiple triggers, fan-in — and an ordered-list schema would force a migration the day it arrives. The v1 interpreter simply walks the single unlabeled outgoing edge of each node.

Considered: phases with an `order` column (rejected — closes the builder door); conditions as node types (rejected — the reference UI puts branch labels on edges, and a node with multiple labeled outgoing edges is a branch with no extra machinery).

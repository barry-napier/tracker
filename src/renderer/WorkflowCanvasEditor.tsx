import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  DraftGraph,
  DraftNode,
  DraftViolation,
  WorkflowDraft,
  WorkflowHeadGraph,
  WorkflowListing,
  WorkflowStepType,
} from "../server/types.ts";
import { WORKFLOW_STEP_TYPES } from "../server/types.ts";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut, errorMessage } from "./api.ts";
import { AVATAR_COLORS, avatarColor } from "./Home.tsx";
import { Icon, isIconName, type IconName } from "./icons.tsx";
import {
  addEdge,
  addPhase,
  addStep,
  autoLayout,
  deleteEdge,
  deleteNode,
  deleteStep,
  NODE_W,
  nodeHeight,
  relabelEdge,
  STEP_TYPE_LABELS,
  updateNode,
  updateStep,
  violationsByEdge,
  violationsByNode,
} from "./canvasModel.ts";

type Selection =
  | { kind: "node"; key: string; stepIndex?: number }
  | { kind: "edge"; index: number }
  | null;

const STEP_TYPE_ICONS: Record<WorkflowStepType, IconName> = {
  "search-global": "book",
  "search-project": "folder",
  "search-code": "code",
  "search-web": "globe",
  action: "play",
  author: "pencil",
};

/** What a stage node renders from; violations ride along for in-place display. */
type StageNodeData = {
  node: DraftNode;
  messages: string[];
  // Click on the bottom port opens the stage-kind menu right below the node
  // (same menu a drag-to-empty-canvas opens at the drop point).
  onCreateChild: (at: { x: number; y: number }, screen: { x: number; y: number }) => void;
  // A step row on the card selects the node with the inspector opened there.
  onOpenStep: (index: number) => void;
};
type StageNode = FlowNode<StageNodeData, "stage">;

/** Edge payload: the label plus everything the label pill's tools need. */
type StageEdgeData = {
  label: string | null;
  messages: string[];
  // Unlabeled on a branching node: the pill renders as an "Add condition"
  // prompt so the ambiguity is visible before Test/publish flags it.
  needsLabel: boolean;
  onSelect: () => void;
  onRelabel: (label: string) => void;
  onDelete: () => void;
};
type StageEdge = FlowEdge<StageEdgeData, "stage">;

/**
 * The workflow canvas editor (ticket 48): a Home view opened from a library
 * row. Renders the Draft when one exists, otherwise the head version —
 * opening is not an edit; the Draft is cut server-side by the first PUT.
 * Every mutation funnels through the pure canvasModel ops, then a debounced
 * PUT of the whole graph. Publish runs ticket 47's validator; violations
 * render on the offending nodes and edges. Layout is view-only state:
 * positions come from autoLayout and dragging, and are never persisted.
 *
 * The canvas itself is React Flow (@xyflow/react): pan/zoom, node drag,
 * handle-drag connections, and fitView come from the library; the graph
 * semantics stay ours — every gesture still lands in a canvasModel op.
 */
export function WorkflowCanvasEditor({
  workflow,
  onClose,
}: {
  workflow: WorkflowListing;
  onClose: () => void;
}) {
  const [graph, setGraph] = useState<DraftGraph | null>(null);
  // Identity metadata (name, appearance, archived): editable from the chrome,
  // so the listing prop is only the initial value.
  const [meta, setMeta] = useState<WorkflowListing>(workflow);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [version, setVersion] = useState(workflow.version);
  const [hasDraft, setHasDraft] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [sel, setSel] = useState<Selection>(null);
  const [violations, setViolations] = useState<DraftViolation[]>([]);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // A connection dropped on empty canvas: the stage-kind menu decides what
  // gets created there (Lindy's "Select next step"); null = no menu up.
  const [pendingChild, setPendingChild] = useState<{
    from: string;
    at: { x: number; y: number };
    screen: { x: number; y: number };
  } | null>(null);
  // Set by a Test run that came back clean; any edit clears it.
  const [testOk, setTestOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The edit chat (LLM applies asks to the draft); open state and transcript
  // are view-local — the draft itself is the state that matters.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatLog, setChatLog] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  // A failed ask lands here (banner above the input), not in the transcript;
  // the failed message rides along so Retry can resend it.
  const [chatError, setChatError] = useState<{ message: string; failed: string } | null>(null);
  // A fresh load re-lays-out the graph; the next render fits it on screen.
  const needsCenter = useRef(false);

  const load = useCallback(async () => {
    try {
      const head = await apiGet<WorkflowHeadGraph>(`/api/workflows/${workflow.id}/head`);
      let opened = head.graph;
      if (head.hasDraft) {
        const draft = await apiGet<WorkflowDraft>(`/api/workflows/${workflow.id}/draft`);
        opened = draft.graph;
      }
      setGraph(opened);
      setHasDraft(head.hasDraft);
      setVersion(head.version);
      setPositions(autoLayout(opened));
      needsCenter.current = true;
      setSel(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [workflow.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // Debounced persistence: the graph in state is the truth; the server sees
  // it shortly after. flush() forces the write — publish must not race it.
  const pending = useRef<DraftGraph | null>(null);
  const timer = useRef<number | null>(null);
  const flush = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const toWrite = pending.current;
    pending.current = null;
    if (toWrite === null) return;
    await apiPut(`/api/workflows/${workflow.id}/draft`, toWrite);
  }, [workflow.id]);
  // Not a functional setGraph update on purpose: the side effects (draft
  // flag, violation reset, debounce timer) must run exactly once per edit,
  // and an updater body re-runs under StrictMode. Edits always derive from
  // the graph of the render they happened in, so the closure value is right.
  const apply = (next: DraftGraph) => {
    if (graph === null || next === graph) return;
    setGraph(next);
    // The first edit is what cuts the Draft (banner + library flag).
    setHasDraft(true);
    setViolations([]);
    setTestOk(false);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void flush().catch((e) => setError(errorMessage(e)));
    }, 400);
  };

  // Identity actions from the chrome's name menu / appearance picker.
  const patchMeta = async (
    patch: Partial<Pick<WorkflowListing, "name" | "color" | "icon">>,
  ) => {
    try {
      setMeta(await apiPatch<WorkflowListing>(`/api/workflows/${workflow.id}`, patch));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const duplicate = async () => {
    try {
      await apiPost(`/api/workflows/${workflow.id}/duplicate`, {});
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toggleArchived = async () => {
    try {
      const verb = meta.archived ? "unarchive" : "archive";
      setMeta(await apiPost<WorkflowListing>(`/api/workflows/${workflow.id}/${verb}`, {}));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const deleteWorkflow = async () => {
    try {
      await apiDelete(`/api/workflows/${workflow.id}`);
      onClose();
    } catch (e) {
      setConfirmingDelete(false);
      setError(errorMessage(e));
    }
  };

  // Share: the workflow as a portable JSON file — identity metadata plus the
  // graph exactly as the canvas shows it (draft included if one is open).
  const share = () => {
    if (graph === null) return;
    const payload = {
      tracker: "workflow" as const,
      name: meta.name,
      description: meta.description,
      color: meta.color,
      icon: meta.icon,
      graph,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Test: the publish validator, dry-run. Violations land on the canvas the
  // same way a failed publish paints them; a clean run shows an OK pill.
  const test = async () => {
    try {
      await flush();
      const result = await apiPost<{ violations: DraftViolation[] }>(
        `/api/workflows/${workflow.id}/draft/validate`,
        {},
      );
      setViolations(result.violations);
      setTestOk(result.violations.length === 0);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const publish = async () => {
    try {
      await flush();
      const listed = await apiPost<WorkflowListing>(`/api/workflows/${workflow.id}/draft/publish`, {});
      setHasDraft(false);
      setViolations([]);
      setTestOk(false);
      setVersion(listed.version);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.body.violations)) {
        setViolations(e.body.violations as DraftViolation[]);
      } else {
        setError(errorMessage(e));
      }
    }
  };

  const discard = async () => {
    setConfirmingDiscard(false);
    try {
      await flush();
      await apiDelete(`/api/workflows/${workflow.id}/draft`);
      setViolations([]);
      setTestOk(false);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const sendChat = async (message: string) => {
    setChatError(null);
    setChatLog((log) => [...log, { role: "user", text: message }]);
    setChatBusy(true);
    try {
      // The model must see the latest edits, so the debounced PUT goes first.
      await flush();
      const result = await apiPost<{ reply: string; draft: WorkflowDraft }>(
        `/api/workflows/${workflow.id}/draft/chat`,
        { message },
      );
      // The server already saved the draft — mirror it, don't re-PUT.
      setGraph(result.draft.graph);
      setHasDraft(true);
      setViolations([]);
      setSel(null);
      setPositions(autoLayout(result.draft.graph));
      needsCenter.current = true;
      setChatLog((log) => [...log, { role: "assistant", text: result.reply }]);
    } catch (e) {
      // The user's bubble stays; the failure surfaces as a banner with Retry.
      setChatError({ message: errorMessage(e), failed: message });
    } finally {
      setChatBusy(false);
    }
  };

  // Delete removes the selection — except the trigger, which the model refuses.
  // Ours rather than React Flow's deleteKeyCode: the model is the authority
  // on what may go, and refusals must not desync the controlled arrays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]")) return;
      if (graph === null || sel === null) return;
      e.preventDefault();
      if (sel.kind === "node") {
        const next = deleteNode(graph, sel.key);
        if (next !== graph) setSel(null);
        apply(next);
      } else {
        apply(deleteEdge(graph, sel.index));
        setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (graph === null) {
    return (
      <div className="wfc-root">
        <EditorChrome workflow={meta} version={version} hasDraft={false} globalViolations={[]} onClose={onClose} />
        {error ? <p className="banner error">{error}</p> : <p className="dim wfc-loading">Loading…</p>}
      </div>
    );
  }

  const nodeViolations = violationsByNode(violations);
  const edgeViolations = violationsByEdge(violations);
  const globalViolations = violations.filter((v) => v.nodeKey === undefined && v.edgeIndex === undefined);
  const selectedNode = sel?.kind === "node" ? graph.nodes.find((n) => n.key === sel.key) ?? null : null;
  const selectedStep = sel?.kind === "node" ? sel.stepIndex ?? null : null;

  const flowNodes: StageNode[] = graph.nodes.map((node) => ({
    id: node.key,
    type: "stage",
    position: positions[node.key] ?? { x: 0, y: 0 },
    selected: sel?.kind === "node" && sel.key === node.key,
    data: {
      node,
      messages: nodeViolations.get(node.key) ?? [],
      onCreateChild: (at, screen) => setPendingChild({ from: node.key, at, screen }),
      onOpenStep: (index) => {
        setSel({ kind: "node", key: node.key, stepIndex: index });
        setPendingChild(null);
      },
    },
  }));
  const flowEdges: StageEdge[] = graph.edges.map((edge, index) => ({
    id: `e${index}`,
    source: edge.from,
    target: edge.to,
    type: "stage",
    selected: sel?.kind === "edge" && sel.index === index,
    data: {
      label: edge.conditionLabel,
      messages: edgeViolations.get(index) ?? [],
      needsLabel:
        edge.conditionLabel === null &&
        graph.edges.filter((e) => e.from === edge.from).length >= 2,
      onSelect: () => {
        setSel({ kind: "edge", index });
        setPendingChild(null);
      },
      onRelabel: (label: string) => apply(relabelEdge(graph, index, label)),
      onDelete: () => {
        apply(deleteEdge(graph, index));
        setSel(null);
      },
    },
  }));

  // Node drags land in our positions map; selection is ours via clicks, so
  // every other change kind is deliberately ignored.
  const onNodesChange = (changes: NodeChange<StageNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const at = change.position;
        setPositions((p) => ({ ...p, [change.id]: at }));
      }
    }
  };

  const onConnect = (connection: Connection) => {
    const next = addEdge(graph, connection.source, connection.target);
    if (next === graph) return; // refused: self-edge, duplicate, into trigger
    apply(next);
    // The connect created a fan-out: branches need condition labels, so the
    // fresh edge opens straight into its label editor (Lindy asks at the
    // fork, not at publish).
    if (next.edges.filter((e) => e.from === connection.source).length >= 2) {
      setSel({ kind: "edge", index: next.edges.length - 1 });
    }
  };

  return (
    <div className="wfc-root">
      <EditorChrome
        workflow={meta}
        version={version}
        hasDraft={hasDraft}
        globalViolations={globalViolations}
        testOk={testOk}
        onClose={() => (hasDraft ? setConfirmingLeave(true) : onClose())}
        onTest={hasDraft ? () => void test() : undefined}
        onPublish={hasDraft ? () => void publish() : undefined}
        onDiscard={hasDraft ? () => setConfirmingDiscard(true) : undefined}
        onShare={share}
        onPatchMeta={(patch) => void patchMeta(patch)}
        onDuplicate={() => void duplicate()}
        onToggleArchived={() => void toggleArchived()}
        onDelete={() => setConfirmingDelete(true)}
      />
      {error && <p className="banner error wfc-error">{error}</p>}
      <div className="wfc-canvas">
        <ReactFlowProvider>
          <FlowCanvas
            nodes={flowNodes}
            edges={flowEdges}
            needsCenter={needsCenter}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((open) => !open)}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onSelect={(next) => {
              setSel(next);
              setPendingChild(null);
            }}
            onCreateChild={(from, at, screen) => {
              // A connection dropped on empty canvas asks what kind of stage
              // grows there; creation happens when the menu answers.
              setPendingChild({ from, at, screen });
            }}
          />
          {pendingChild && (
            <div
              className="wfc-kind-menu"
              style={{ left: pendingChild.screen.x, top: pendingChild.screen.y }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="menu-label">Select next stage</span>
              {WORKFLOW_STEP_TYPES.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    const { from, at } = pendingChild;
                    setPendingChild(null);
                    const { graph: withNode, key } = addPhase(graph, kind);
                    setPositions((p) => ({ ...p, [key]: { x: at.x - NODE_W / 2, y: at.y } }));
                    apply(addEdge(withNode, from, key));
                    setSel({ kind: "node", key });
                  }}
                >
                  <span className="wfc-step-icon">
                    <Icon name={STEP_TYPE_ICONS[kind]} size={14} />
                  </span>
                  {STEP_TYPE_LABELS[kind]}
                  <span className="wfc-step-plus">+</span>
                </button>
              ))}
            </div>
          )}
          {chatOpen && (
            <ChatPanel
              log={chatLog}
              busy={chatBusy}
              error={chatError}
              onSend={(m) => void sendChat(m)}
              onRetry={() => {
                if (chatError === null) return;
                const failed = chatError.failed;
                // The failed ask already sits in the log as the last user
                // bubble — drop it so the resend doesn't double it.
                setChatLog((log) => log.slice(0, -1));
                void sendChat(failed);
              }}
              onClear={() => {
                setChatLog([]);
                setChatError(null);
              }}
              onClose={() => setChatOpen(false)}
            />
          )}
          {selectedNode && (
            <Inspector
              // stepIndex in the key: a card's step-row click re-mounts the
              // inspector drilled into that step, even mid-edit.
              key={`${selectedNode.key}:${selectedStep ?? "stage"}`}
              node={selectedNode}
              initialStep={selectedStep}
              onPatch={(patch) => apply(updateNode(graph, selectedNode.key, patch))}
              onAddStep={(type) => apply(addStep(graph, selectedNode.key, type))}
              onPatchStep={(index, patch) => apply(updateStep(graph, selectedNode.key, index, patch))}
              onDeleteStep={(index) => apply(deleteStep(graph, selectedNode.key, index))}
              onDelete={() => {
                apply(deleteNode(graph, selectedNode.key));
                setSel(null);
              }}
            />
          )}
        </ReactFlowProvider>
      </div>
      {confirmingDiscard && (
        <div className="wf-overlay" onClick={() => setConfirmingDiscard(false)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Discard unpublished changes?</h3>
            <p className="dim">
              The draft is thrown away and the canvas returns to v{version} — the published head is
              untouched either way.
            </p>
            <div className="formrow">
              <button type="button" className="danger" onClick={() => void discard()}>
                Discard draft
              </button>
              <button type="button" onClick={() => setConfirmingDiscard(false)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmingDelete && (
        <div className="wf-overlay" onClick={() => setConfirmingDelete(false)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete "{meta.name}"?</h3>
            <p className="dim">
              This workflow never entered service, so it can be hard-deleted — versions, draft, and
              all. There is no undo.
            </p>
            <div className="formrow">
              <button type="button" className="danger" onClick={() => void deleteWorkflow()}>
                Delete workflow
              </button>
              <button type="button" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmingLeave && (
        <div className="wf-overlay" onClick={() => setConfirmingLeave(false)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Leave with unpublished changes?</h3>
            <p className="dim">
              Your draft is saved and will be here when you come back — but v{version} stays live
              until you publish.
            </p>
            <div className="formrow">
              <button type="button" className="danger" onClick={onClose}>
                Leave
              </button>
              <button type="button" onClick={() => setConfirmingLeave(false)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { stage: StageNodeView };
const edgeTypes = { stage: StageEdgeView };

/**
 * The React Flow surface. A separate component because fitView and
 * screenToFlowPosition come from useReactFlow, which needs the provider
 * above it.
 */
function FlowCanvas({
  nodes,
  edges,
  needsCenter,
  chatOpen,
  onToggleChat,
  onNodesChange,
  onConnect,
  onSelect,
  onCreateChild,
}: {
  nodes: StageNode[];
  edges: StageEdge[];
  needsCenter: React.MutableRefObject<boolean>;
  chatOpen: boolean;
  onToggleChat: () => void;
  onNodesChange: (changes: NodeChange<StageNode>[]) => void;
  onConnect: (connection: Connection) => void;
  onSelect: (sel: Selection) => void;
  onCreateChild: (from: string, at: { x: number; y: number }, screen: { x: number; y: number }) => void;
}) {
  const { fitView, screenToFlowPosition } = useReactFlow();

  // A fresh load fits the laid-out graph to the viewport (centered, and
  // zoomed out if it overflows — never zoomed in past 1:1).
  useEffect(() => {
    if (!needsCenter.current || nodes.length === 0) return;
    needsCenter.current = false;
    void fitView({ padding: 0.2, maxZoom: 1 });
  }, [nodes, fitView, needsCenter]);

  const onConnectEnd: OnConnectEnd = (event, connectionState) => {
    // isValid is null when the drop hit empty pane rather than a handle.
    if (connectionState.isValid !== null || !connectionState.fromNode) return;
    const at = "changedTouches" in event ? event.changedTouches[0]! : event;
    onCreateChild(
      connectionState.fromNode.id,
      screenToFlowPosition({ x: at.clientX, y: at.clientY }),
      { x: at.clientX, y: at.clientY },
    );
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onNodeClick={(_, node) => onSelect({ kind: "node", key: node.id })}
      onNodeDragStart={(_, node) => onSelect({ kind: "node", key: node.id })}
      onEdgeClick={(_, edge) => onSelect({ kind: "edge", index: Number(edge.id.slice(1)) })}
      onPaneClick={() => onSelect(null)}
      deleteKeyCode={null}
      connectOnClick={false}
      minZoom={0.25}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} color="var(--border-strong)" />
      <CanvasToolbar chatOpen={chatOpen} onToggleChat={onToggleChat} />
    </ReactFlow>
  );
}

/**
 * The bottom-center toolbar (the Lindy layout): the Ask toggle for the edit
 * chat, then the −/%/+ zoom cluster; the % button refits the whole graph.
 */
function CanvasToolbar({ chatOpen, onToggleChat }: { chatOpen: boolean; onToggleChat: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="wfc-toolbar">
      <button type="button" className={chatOpen ? "wfc-ask active" : "wfc-ask"} onClick={onToggleChat}>
        <Icon name="sparkle" size={14} /> Ask
      </button>
      <span className="wfc-toolbar-divider" />
      <button type="button" onClick={() => void zoomOut()}>−</button>
      <button
        type="button"
        className="wfc-zoom-pct"
        onClick={() => void fitView({ padding: 0.2, maxZoom: 1 })}
        title="Fit view"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={() => void zoomIn()}>+</button>
    </div>
  );
}

function StageNodeView({ data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<StageNode>) {
  const { node, messages } = data;
  const height = nodeHeight(node);
  // A plain click on the port (no drag) asks what stage grows below; the
  // pending-child position mirrors where a dropped connection would land.
  const onPortClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onCreateChild(
      { x: positionAbsoluteX + NODE_W / 2, y: positionAbsoluteY + height + 56 },
      { x: e.clientX, y: e.clientY },
    );
  };
  return (
    <div>
      <div
        className={`wfc-node${selected ? " selected" : ""}${node.type === "trigger" ? " trigger" : ""}${node.steps.length > 0 ? " has-steps" : ""}${messages.length > 0 ? " violation" : ""}`}
        style={{ width: NODE_W, height }}
      >
        {/* The model refuses edges into the trigger, so it offers no target. */}
        {node.type !== "trigger" && <Handle type="target" position={Position.Top} />}
        <span className="wfc-node-name">
          {node.type === "trigger" && <Icon name="bolt" size={14} className="wfc-node-icon" />}
          {/* The stored key stays "ticket-claimed"; the label is display-only. */}
          {node.type === "trigger" ? "Ticket claimed" : node.name}
        </span>
        <span className="wfc-badges">
          {node.emitsChecks && <span className="wfc-pill ok">checks</span>}
          {node.gateRequirements.length > 0 && (
            <span className="wfc-pill info" title={`owes ${node.gateRequirements.join(", ")}`}>
              owes
            </span>
          )}
        </span>
        {/* Steps read on the card (the Lindy legibility): icon + title rows;
            a row click opens the inspector already drilled into that step. */}
        {node.steps.length > 0 && (
          <span className="wfc-node-steps">
            {node.steps.map((s, i) => (
              <button
                key={i}
                type="button"
                className="wfc-node-steprow"
                title={STEP_TYPE_LABELS[s.type]}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onOpenStep(i);
                }}
              >
                <span className="wfc-step-icon">
                  <Icon name={STEP_TYPE_ICONS[s.type]} size={13} />
                </span>
                <span className="wfc-step-title">{s.title}</span>
              </button>
            ))}
          </span>
        )}
        <Handle
          type="source"
          position={Position.Bottom}
          className="wfc-port"
          title="Click to add a stage, drag to connect"
          onClick={onPortClick}
        />
      </div>
      {messages.length > 0 && (
        <ul className="wfc-violations" style={{ width: NODE_W }}>
          {messages.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StageEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  data,
}: EdgeProps<StageEdge>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const label = data?.label ?? null;
  const messages = data?.messages ?? [];
  const needsLabel = data?.needsLabel ?? false;
  // Pills anchor a fixed drop below the source port (not the edge midpoint),
  // so sibling branch pills line up even when their targets sit at different
  // heights; x follows the edge's slope at that y. Short edges fall back to
  // the midpoint so the pill never overshoots the target.
  const PILL_DROP = 34;
  const t =
    targetY - sourceY > PILL_DROP * 2 ? PILL_DROP / (targetY - sourceY) : 0.5;
  const pillX = sourceX + (targetX - sourceX) * t;
  const pillY = sourceY + (targetY - sourceY) * t;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`wfc-edge-path${selected ? " selected" : ""}${messages.length > 0 ? " violation" : ""}`}
      />
      {(selected || label !== null || needsLabel || messages.length > 0) && (
        <EdgeLabelRenderer>
          <div
            className="wfc-edge-label"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${pillX}px, ${pillY}px)`,
              pointerEvents: "all",
            }}
          >
            {selected ? (
              <EdgeTools
                label={label}
                onRelabel={(l) => data?.onRelabel(l)}
                onDelete={() => data?.onDelete()}
              />
            ) : label !== null ? (
              // The branch pill is a first-class control: click to edit.
              <button type="button" className="wfc-edge-pill" onClick={() => data?.onSelect()}>
                {label}
              </button>
            ) : (
              needsLabel && (
                <button
                  type="button"
                  className="wfc-edge-pill needs"
                  title="Branches walk their condition labels — unlabeled edges here won't publish"
                  onClick={() => data?.onSelect()}
                >
                  Add condition
                </button>
              )
            )}
            {messages.map((message, i) => (
              <span key={i} className="wfc-edge-violation">
                {message}
              </span>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A selected edge's inline tools: the condition-label input and remove. */
function EdgeTools({
  label,
  onRelabel,
  onDelete,
}: {
  label: string | null;
  onRelabel: (label: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(label ?? "");
  return (
    <span className="wfc-edge-tools">
      <input
        autoFocus
        placeholder="condition label"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onRelabel(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRelabel(draft);
          if (e.key === "Escape") setDraft(label ?? "");
        }}
      />
      <button type="button" title="Remove edge" onClick={onDelete}>
        <Icon name="close-small" size={14} />
      </button>
    </span>
  );
}

/**
 * The edit chat: describe a change, the model rewrites the draft. Floats
 * bottom-left, opposite the inspector — the canvas stays the main event.
 */
/** Browser dictation, when the engine offers it (Chrome/Electron do). */
type SpeechRecognitionLike = {
  new (): {
    continuous: boolean;
    interimResults: boolean;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  };
};

function speechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionLike; webkitSpeechRecognition?: SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function ChatPanel({
  log,
  busy,
  error,
  onSend,
  onRetry,
  onClear,
  onClose,
}: {
  log: { role: "user" | "assistant"; text: string }[];
  busy: boolean;
  error: { message: string; failed: string } | null;
  onSend: (message: string) => void;
  onRetry: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const recognizerRef = useRef<InstanceType<SpeechRecognitionLike> | null>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, busy]);
  // Unmount mid-dictation must not leave the mic hot.
  useEffect(() => () => recognizerRef.current?.stop(), []);

  const submit = () => {
    const message = draft.trim();
    if (message === "" || busy) return;
    recognizerRef.current?.stop();
    setDraft("");
    onSend(message);
  };

  // Grow with the draft, up to the CSS max-height.
  const autosize = () => {
    const el = textRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const attach = async (file: File) => {
    const text = await file.text();
    setDraft((d) => `${d === "" ? "" : `${d}\n\n`}Attached ${file.name}:\n${text}`);
    requestAnimationFrame(autosize);
  };

  const toggleMic = () => {
    if (listening) {
      recognizerRef.current?.stop();
      return;
    }
    const Recognition = speechRecognition();
    if (Recognition === null) return;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const finals = Array.from(e.results, (r) => (r.isFinal ? r[0]!.transcript : "")).join("");
      if (finals !== "") {
        setDraft((d) => (d === "" ? finals.trim() : `${d} ${finals.trim()}`));
        requestAnimationFrame(autosize);
      }
    };
    rec.onend = () => {
      setListening(false);
      recognizerRef.current = null;
    };
    recognizerRef.current = rec;
    setListening(true);
    rec.start();
  };

  return (
    <div className="wfc-chat" onPointerDown={(e) => e.stopPropagation()}>
      <div className="wfc-chat-head">
        <span className="wfc-chat-badge">
          <Icon name="sparkle" size={13} />
        </span>
        <span>Assistant</span>
        <span className="wfc-chat-head-actions">
          <span className="wfc-chat-menu-anchor">
            <button type="button" className="icon-btn" title="More options" onClick={() => setMenuOpen((open) => !open)}>
              <Icon name="dots-horizontal" size={14} />
            </button>
            {menuOpen && (
              <div className="wfc-chat-menu" onPointerLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onClear();
                  }}
                >
                  Clear conversation
                </button>
              </div>
            )}
          </span>
          <button type="button" className="icon-btn" title="New conversation" onClick={onClear}>
            <Icon name="chat-new" size={14} />
          </button>
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <Icon name="close-small" size={14} />
          </button>
        </span>
      </div>
      <div className="wfc-chat-log" ref={logRef}>
        {log.length === 0 && (
          <div className="wfc-chat-empty">
            <span className="wfc-chat-empty-art" aria-hidden="true">
              <svg width="64" height="52" viewBox="0 0 64 52" fill="none">
                <rect x="14" y="6" width="36" height="14" rx="3" stroke="currentColor" />
                <rect x="14" y="32" width="36" height="14" rx="3" stroke="currentColor" />
                <path d="M32 20V32" stroke="currentColor" />
                <path d="M20 13H24M28 13H44M20 39H24M28 39H44" stroke="currentColor" strokeLinecap="round" />
              </svg>
            </span>
            <span className="wfc-chat-empty-title">Ask the Assistant</span>
            <span className="dim">Create or edit the workflow.</span>
          </div>
        )}
        {log.map((entry, i) => (
          <p key={i} className={`wfc-chat-msg ${entry.role}`}>
            {entry.text}
          </p>
        ))}
        {busy && <p className="wfc-chat-msg assistant dim">Thinking…</p>}
      </div>
      {error && (
        <div className="wfc-chat-error">
          <Icon name="warning" size={14} />
          <span className="wfc-chat-error-text">{error.message}</span>
          <button type="button" className="link" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      <div className="wfc-chat-inputbox">
        <textarea
          ref={textRef}
          rows={1}
          placeholder="Enter message"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="wfc-chat-inputactions">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.json,.yaml,.yml,.csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void attach(file);
            }}
          />
          <button type="button" className="icon-btn" title="Attach a text file" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" size={15} />
          </button>
          {speechRecognition() !== null && (
            <button
              type="button"
              className={listening ? "icon-btn wfc-mic listening" : "icon-btn wfc-mic"}
              title={listening ? "Stop dictation" : "Dictate"}
              onClick={toggleMic}
            >
              <Icon name="mic" size={15} />
            </button>
          )}
          <button
            type="button"
            className="wfc-chat-send"
            title="Send"
            disabled={busy || draft.trim() === ""}
            onClick={submit}
          >
            <Icon name="arrow-up" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The appearance picker's icon offer: the drawing icons, not UI chrome. */
const WORKFLOW_ICONS: IconName[] = [
  "bolt",
  "globe",
  "book",
  "folder",
  "code",
  "play",
  "pencil",
  "search",
  "sparkle",
  "check",
  "settings-gear",
];

function EditorChrome({
  workflow,
  version,
  hasDraft,
  globalViolations,
  testOk = false,
  onClose,
  onTest,
  onShare,
  onPublish,
  onDiscard,
  onPatchMeta,
  onDuplicate,
  onToggleArchived,
  onDelete,
}: {
  workflow: WorkflowListing;
  version: number;
  hasDraft: boolean;
  globalViolations: DraftViolation[];
  testOk?: boolean;
  onClose: () => void;
  onTest?: () => void;
  onShare?: () => void;
  onPublish?: () => void;
  onDiscard?: () => void;
  onPatchMeta?: (patch: Partial<Pick<WorkflowListing, "name" | "color" | "icon">>) => void;
  onDuplicate?: () => void;
  onToggleArchived?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState<"menu" | "appearance" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);
  // Click-away closes whichever popover is up.
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const submitRename = () => {
    setRenaming(false);
    const name = draftName.trim();
    if (name !== "" && name !== workflow.name) onPatchMeta?.({ name });
  };

  return (
    <div className="wfc-chrome">
      <button type="button" className="wfc-back" onClick={onClose}>
        <Icon name="chevron-left" size={16} /> Workflows
      </button>
      <span className="wfc-title" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="avatar wfc-avatar-btn"
          title="Color and icon"
          style={{ background: workflow.color ?? avatarColor(workflow.name) }}
          onClick={() => setOpen(open === "appearance" ? null : "appearance")}
        >
          {workflow.icon !== null && isIconName(workflow.icon) ? (
            <Icon name={workflow.icon} size={14} />
          ) : (
            workflow.name.slice(0, 1).toUpperCase()
          )}
        </button>
        {renaming ? (
          <input
            autoFocus
            className="wf-rename"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="wfc-title-btn"
            onClick={() => setOpen(open === "menu" ? null : "menu")}
          >
            {workflow.name} <span className="dim">v{version}</span>
            <Icon name="chevron-down" size={14} />
          </button>
        )}
        {open === "menu" && (
          <div className="row-menu wfc-title-menu" role="menu">
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                setDraftName(workflow.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                onDuplicate?.();
              }}
            >
              Duplicate
            </button>
            <hr className="menu-divider" />
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                onToggleArchived?.();
              }}
            >
              {workflow.archived ? "Unarchive" : "Archive"}
            </button>
            <button
              type="button"
              className="danger"
              disabled={!workflow.deletable}
              title={workflow.deletable ? undefined : "In service — archive instead"}
              onClick={() => {
                setOpen(null);
                onDelete?.();
              }}
            >
              Delete
            </button>
          </div>
        )}
        {open === "appearance" && (
          <div className="row-menu wfc-appearance" role="menu">
            <span className="menu-label">Color</span>
            <div className="wfc-swatches">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`wfc-swatch${workflow.color === color ? " selected" : ""}`}
                  style={{ background: color }}
                  onClick={() => onPatchMeta?.({ color })}
                />
              ))}
              <button
                type="button"
                className={`wfc-swatch auto${workflow.color === null ? " selected" : ""}`}
                title="Auto (from name)"
                style={{ background: avatarColor(workflow.name) }}
                onClick={() => onPatchMeta?.({ color: null })}
              >
                A
              </button>
            </div>
            <span className="menu-label">Icon</span>
            <div className="wfc-iconsgrid">
              <button
                type="button"
                className={`wfc-iconpick${workflow.icon === null ? " selected" : ""}`}
                title="Letter (from name)"
                onClick={() => onPatchMeta?.({ icon: null })}
              >
                {workflow.name.slice(0, 1).toUpperCase()}
              </button>
              {WORKFLOW_ICONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`wfc-iconpick${workflow.icon === name ? " selected" : ""}`}
                  onClick={() => onPatchMeta?.({ icon: name })}
                >
                  <Icon name={name} size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
      </span>
      {hasDraft && <span className="wfc-pill warn">Draft — unpublished changes</span>}
      {globalViolations.map((v, i) => (
        <span key={i} className="wfc-pill danger">
          {v.message}
        </span>
      ))}
      <span className="wfc-chrome-actions">
        {testOk && <span className="wfc-pill ok">Checks pass</span>}
        {onDiscard && (
          <button type="button" onClick={onDiscard}>
            Discard
          </button>
        )}
        <button type="button" onClick={onTest} disabled={!onTest}>
          Test
        </button>
        <button type="button" onClick={onShare} disabled={!onShare} title="Download as JSON">
          Share
        </button>
        <button type="button" className="primary" onClick={onPublish} disabled={!onPublish}>
          Publish
        </button>
      </span>
    </div>
  );
}

/**
 * The floating inspector (Variant A): phase fields, the Steps drill-in
 * (ordered typed rows → per-step title+prompt editor), and stage delete.
 * The trigger renders read-only — fixed in v1.
 */
function Inspector({
  node,
  initialStep = null,
  onPatch,
  onAddStep,
  onPatchStep,
  onDeleteStep,
  onDelete,
}: {
  node: DraftNode;
  /** Open drilled into this step (a card step-row click); null = stage view. */
  initialStep?: number | null;
  onPatch: (patch: Partial<Pick<DraftNode, "name" | "promptTemplate" | "emitsChecks" | "gateRequirements">>) => void;
  onAddStep: (type: WorkflowStepType) => void;
  onPatchStep: (index: number, patch: { title?: string; prompt?: string }) => void;
  onDeleteStep: (index: number) => void;
  onDelete: () => void;
}) {
  const [openStep, setOpenStep] = useState<number | null>(initialStep);
  const [adding, setAdding] = useState(false);
  // gateRequirements edits commit on blur — a half-typed path is not a list.
  const [gates, setGates] = useState(node.gateRequirements.join(", "));

  if (node.type === "trigger") {
    return (
      <div className="wfc-inspector" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Ticket claimed</h3>
        <p className="dim">The trigger. Fixed in v1 — not editable or deletable.</p>
      </div>
    );
  }

  const step = openStep !== null ? node.steps[openStep] : undefined;
  if (step !== undefined && openStep !== null) {
    return (
      <div className="wfc-inspector" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="wfc-linklike" onClick={() => setOpenStep(null)}>
          ← {node.name}
        </button>
        <h3>{step.title}</h3>
        <span className="wfc-pill label">
          <Icon name={STEP_TYPE_ICONS[step.type]} size={12} className="wfc-pill-icon" />
          {STEP_TYPE_LABELS[step.type]}
        </span>
        <label>
          Title
          <input value={step.title} onChange={(e) => onPatchStep(openStep, { title: e.target.value })} />
        </label>
        <label>
          Prompt
          <textarea
            rows={5}
            value={step.prompt}
            onChange={(e) => onPatchStep(openStep, { prompt: e.target.value })}
          />
        </label>
        <p className="dim wfc-hint">
          Steps compile into this stage's single session prompt — they never run on their own.
        </p>
        <button
          type="button"
          className="wfc-linklike danger"
          onClick={() => {
            setOpenStep(null);
            onDeleteStep(openStep);
          }}
        >
          Delete step
        </button>
      </div>
    );
  }

  return (
    <div className="wfc-inspector" onPointerDown={(e) => e.stopPropagation()}>
      <h3>{node.name}</h3>
      <label>
        Name
        <input value={node.name} onChange={(e) => onPatch({ name: e.target.value })} />
      </label>
      <label>
        Prompt template
        <textarea
          className="wfc-prompt-template"
          rows={20}
          value={node.promptTemplate ?? ""}
          onChange={(e) => onPatch({ promptTemplate: e.target.value === "" ? null : e.target.value })}
        />
      </label>
      <div className="wfc-steps">
        <span className="wfc-steps-head">Steps</span>
        {node.steps.length === 0 && (
          <span className="dim wfc-hint">No steps — the stage prompt runs alone.</span>
        )}
        {node.steps.map((s, i) => (
          <button key={i} type="button" className="wfc-step-row" onClick={() => setOpenStep(i)}>
            <span className="wfc-step-num">{i + 1}</span>
            <span className="wfc-step-icon">
              <Icon name={STEP_TYPE_ICONS[s.type]} size={14} />
            </span>
            <span className="wfc-step-title">{s.title}</span>
            <span className="wfc-pill label">{STEP_TYPE_LABELS[s.type]}</span>
          </button>
        ))}
        {adding ? (
          <div className="wfc-step-menu">
            <span className="wfc-steps-head">Add step</span>
            {WORKFLOW_STEP_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="wfc-step-row"
                onClick={() => {
                  setAdding(false);
                  onAddStep(type);
                }}
              >
                <span className="wfc-step-icon">
                  <Icon name={STEP_TYPE_ICONS[type]} size={14} />
                </span>
                <span className="wfc-step-title">{STEP_TYPE_LABELS[type]}</span>
                <span className="wfc-step-plus">+</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="wfc-linklike" onClick={() => setAdding(true)}>
            + Add step
          </button>
        )}
      </div>
      <label className="row">
        <input
          type="checkbox"
          checked={node.emitsChecks}
          onChange={(e) => onPatch({ emitsChecks: e.target.checked })}
        />{" "}
        Emits AC checks
      </label>
      <label>
        Owes artifacts
        <input
          placeholder="kb/recap.html"
          value={gates}
          onChange={(e) => setGates(e.target.value)}
          onBlur={() =>
            onPatch({
              gateRequirements: gates
                .split(",")
                .map((g) => g.trim())
                .filter((g) => g !== ""),
            })
          }
        />
      </label>
      <button type="button" className="wfc-linklike danger" onClick={onDelete}>
        Delete stage
      </button>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
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
import { ApiError, apiDelete, apiGet, apiPost, apiPut, errorMessage } from "./api.ts";
import { Icon } from "./icons.tsx";
import {
  addEdge,
  addPhase,
  addStep,
  autoLayout,
  deleteEdge,
  deleteNode,
  deleteStep,
  NODE_H,
  NODE_W,
  relabelEdge,
  STEP_TYPE_LABELS,
  updateNode,
  updateStep,
  violationsByEdge,
  violationsByNode,
} from "./canvasModel.ts";

type Selection = { kind: "node"; key: string } | { kind: "edge"; index: number } | null;

interface View {
  x: number;
  y: number;
  scale: number;
}

/**
 * The workflow canvas editor (ticket 48): a Home view opened from a library
 * row. Renders the Draft when one exists, otherwise the head version —
 * opening is not an edit; the Draft is cut server-side by the first PUT.
 * Every mutation funnels through the pure canvasModel ops, then a debounced
 * PUT of the whole graph. Publish runs ticket 47's validator; violations
 * render on the offending nodes and edges. Layout is view-only state:
 * positions come from autoLayout and dragging, and are never persisted.
 */
export function WorkflowCanvasEditor({
  workflow,
  onClose,
}: {
  workflow: WorkflowListing;
  onClose: () => void;
}) {
  const [graph, setGraph] = useState<DraftGraph | null>(null);
  const [version, setVersion] = useState(workflow.version);
  const [hasDraft, setHasDraft] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [sel, setSel] = useState<Selection>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [violations, setViolations] = useState<DraftViolation[]>([]);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const pan = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  // Edge creation: pointer-down on a node's port, release over the target.
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);

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
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void flush().catch((e) => setError(errorMessage(e)));
    }, 400);
  };

  const publish = async () => {
    try {
      await flush();
      const listed = await apiPost<WorkflowListing>(`/api/workflows/${workflow.id}/draft/publish`, {});
      setHasDraft(false);
      setViolations([]);
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
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Wheel zoom toward the cursor; native listener because React's onWheel is passive.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const scale = Math.min(2.5, Math.max(0.25, v.scale * Math.exp(-e.deltaY * 0.002)));
        const k = scale / v.scale;
        return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graph === null]);

  // Delete removes the selection — except the trigger, which the model refuses.
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
  }, [graph, sel, apply]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.x) / view.scale,
      y: (e.clientY - rect.top - view.y) / view.scale,
    };
  };

  const onNodeDown = (key: string, e: React.PointerEvent) => {
    e.stopPropagation();
    const at = positions[key];
    if (!at) return;
    drag.current = { key, startX: e.clientX, startY: e.clientY, origX: at.x, origY: at.y };
    (e.target as Element).setPointerCapture(e.pointerId);
    setSel({ kind: "node", key });
  };
  const onPortDown = (from: string, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setLinking({ from, ...toWorld(e) });
  };
  const onPanDown = (e: React.PointerEvent) => {
    pan.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    (e.target as Element).setPointerCapture(e.pointerId);
    setSel(null);
  };
  const onMove = (e: React.PointerEvent) => {
    if (linking) {
      setLinking({ ...linking, ...toWorld(e) });
      return;
    }
    const d = drag.current;
    if (d) {
      const dx = (e.clientX - d.startX) / view.scale;
      const dy = (e.clientY - d.startY) / view.scale;
      setPositions((p) => ({ ...p, [d.key]: { x: d.origX + dx, y: d.origY + dy } }));
      return;
    }
    const p = pan.current;
    if (p) setView((v) => ({ ...v, x: p.origX + (e.clientX - p.startX), y: p.origY + (e.clientY - p.startY) }));
  };
  const onUp = (e: React.PointerEvent) => {
    if (linking && graph) {
      const at = toWorld(e);
      const target = graph.nodes.find((n) => {
        const p = positions[n.key];
        return p && at.x >= p.x && at.x <= p.x + NODE_W && at.y >= p.y && at.y <= p.y + NODE_H;
      });
      if (target) apply(addEdge(graph, linking.from, target.key));
      setLinking(null);
    }
    drag.current = null;
    pan.current = null;
  };

  const addNode = () => {
    if (graph === null) return;
    const { graph: next, key } = addPhase(graph);
    // Land the new node under everything, roughly centered in the viewport.
    const lowest = Math.max(40, ...Object.values(positions).map((p) => p.y + NODE_H));
    const el = canvasRef.current;
    const centerX = el ? (el.clientWidth / 2 - view.x) / view.scale - NODE_W / 2 : 340;
    setPositions((p) => ({ ...p, [key]: { x: centerX, y: lowest + 44 } }));
    apply(next);
    setSel({ kind: "node", key });
  };

  const zoomBy = (factor: number) =>
    setView((v) => {
      const el = canvasRef.current;
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      const scale = Math.min(2.5, Math.max(0.25, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  if (graph === null) {
    return (
      <div className="wfc-root">
        <EditorChrome workflow={workflow} version={version} hasDraft={false} globalViolations={[]} onClose={onClose} />
        {error ? <p className="banner error">{error}</p> : <p className="dim wfc-loading">Loading…</p>}
      </div>
    );
  }

  const nodeViolations = violationsByNode(violations);
  const edgeViolations = violationsByEdge(violations);
  const globalViolations = violations.filter((v) => v.nodeKey === undefined && v.edgeIndex === undefined);
  const selectedNode = sel?.kind === "node" ? graph.nodes.find((n) => n.key === sel.key) ?? null : null;

  return (
    <div className="wfc-root">
      <EditorChrome
        workflow={workflow}
        version={version}
        hasDraft={hasDraft}
        globalViolations={globalViolations}
        onClose={onClose}
        onPublish={hasDraft ? () => void publish() : undefined}
        onDiscard={hasDraft ? () => setConfirmingDiscard(true) : undefined}
      />
      {error && <p className="banner error wfc-error">{error}</p>}
      <div
        ref={canvasRef}
        className="wfc-canvas"
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${18 * view.scale}px ${18 * view.scale}px`,
        }}
        onPointerDown={onPanDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <div className="wfc-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="wfc-edges">
            {graph.edges.map((edge, index) => {
              const a = positions[edge.from];
              const b = positions[edge.to];
              if (!a || !b) return null;
              const x1 = a.x + NODE_W / 2;
              const y1 = a.y + NODE_H;
              const x2 = b.x + NODE_W / 2;
              const y2 = b.y;
              const selected = sel?.kind === "edge" && sel.index === index;
              const broken = edgeViolations.has(index);
              return (
                <g key={index}>
                  <path
                    d={`M ${x1} ${y1} L ${x2} ${y2}`}
                    className="wfc-edge-hit"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSel({ kind: "edge", index });
                    }}
                  />
                  <path
                    d={`M ${x1} ${y1} L ${x2} ${y2}`}
                    className={`wfc-edge-path${selected ? " selected" : ""}${broken ? " violation" : ""}`}
                  />
                  <EdgeLabel
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2}
                    label={edge.conditionLabel}
                    selected={selected}
                    messages={edgeViolations.get(index) ?? []}
                    onSelect={() => setSel({ kind: "edge", index })}
                    onRelabel={(label) => apply(relabelEdge(graph, index, label))}
                    onDelete={() => {
                      apply(deleteEdge(graph, index));
                      setSel(null);
                    }}
                  />
                </g>
              );
            })}
            {linking && positions[linking.from] && (
              <path
                d={`M ${positions[linking.from]!.x + NODE_W / 2} ${positions[linking.from]!.y + NODE_H} L ${linking.x} ${linking.y}`}
                className="wfc-edge-path linking"
              />
            )}
          </svg>
          {graph.nodes.map((node) => {
            const at = positions[node.key];
            if (!at) return null;
            const messages = nodeViolations.get(node.key) ?? [];
            return (
              <div key={node.key} style={{ position: "absolute", left: at.x, top: at.y }}>
                <div
                  className={`wfc-node${sel?.kind === "node" && sel.key === node.key ? " selected" : ""}${node.type === "trigger" ? " trigger" : ""}${messages.length > 0 ? " violation" : ""}`}
                  style={{ width: NODE_W, height: NODE_H }}
                  onPointerDown={(e) => onNodeDown(node.key, e)}
                >
                  <span className="wfc-node-name">{node.name}</span>
                  <span className="wfc-badges">
                    {node.steps.length > 0 && <span className="wfc-pill label">{node.steps.length} steps</span>}
                    {node.emitsChecks && <span className="wfc-pill ok">checks</span>}
                    {node.gateRequirements.length > 0 && (
                      <span className="wfc-pill info" title={`owes ${node.gateRequirements.join(", ")}`}>
                        owes
                      </span>
                    )}
                  </span>
                  <span
                    className="wfc-port"
                    title="Drag to connect"
                    onPointerDown={(e) => onPortDown(node.key, e)}
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
          })}
        </div>
        <button type="button" className="wfc-add" onClick={addNode}>
          + Add stage
        </button>
        <div className="wfc-zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <button
            type="button"
            className="wfc-zoom-pct"
            onClick={() => setView({ x: 0, y: 0, scale: 1 })}
            title="Reset view"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button type="button" onClick={() => zoomBy(1.25)}>+</button>
        </div>
        {selectedNode && (
          <Inspector
            key={selectedNode.key}
            node={selectedNode}
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
    </div>
  );
}

function EditorChrome({
  workflow,
  version,
  hasDraft,
  globalViolations,
  onClose,
  onPublish,
  onDiscard,
}: {
  workflow: WorkflowListing;
  version: number;
  hasDraft: boolean;
  globalViolations: DraftViolation[];
  onClose: () => void;
  onPublish?: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="wfc-chrome">
      <button type="button" className="wfc-back" onClick={onClose}>
        <Icon name="chevron-left" size={16} /> Workflows
      </button>
      <span className="wfc-title">
        {workflow.name} <span className="dim">v{version}</span>
      </span>
      {hasDraft && <span className="wfc-pill warn">Draft — unpublished changes</span>}
      {globalViolations.map((v, i) => (
        <span key={i} className="wfc-pill danger">
          {v.message}
        </span>
      ))}
      <span className="wfc-chrome-actions">
        {onDiscard && (
          <button type="button" onClick={onDiscard}>
            Discard
          </button>
        )}
        {onPublish && (
          <button type="button" className="primary" onClick={onPublish}>
            Publish
          </button>
        )}
      </span>
    </div>
  );
}

/** A branch edge's label pill; selected, it becomes editable inline. */
function EdgeLabel({
  x,
  y,
  label,
  selected,
  messages,
  onSelect,
  onRelabel,
  onDelete,
}: {
  x: number;
  y: number;
  label: string | null;
  selected: boolean;
  messages: string[];
  onSelect: () => void;
  onRelabel: (label: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(label ?? "");
  useEffect(() => {
    if (selected) setDraft(label ?? "");
  }, [selected, label]);
  if (!selected && label === null && messages.length === 0) return null;
  return (
    <foreignObject x={x - 90} y={y - 14} width="180" height={selected ? 64 : 28 + messages.length * 20}>
      <div className="wfc-edge-label" onPointerDown={(e) => e.stopPropagation()}>
        {selected ? (
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
        ) : (
          label !== null && (
            <button type="button" className="wfc-pill label" onClick={onSelect}>
              {label}
            </button>
          )
        )}
        {messages.map((message, i) => (
          <span key={i} className="wfc-edge-violation">
            {message}
          </span>
        ))}
      </div>
    </foreignObject>
  );
}

/**
 * The floating inspector (Variant A): phase fields, the Steps drill-in
 * (ordered typed rows → per-step title+prompt editor), and stage delete.
 * The trigger renders read-only — fixed in v1.
 */
function Inspector({
  node,
  onPatch,
  onAddStep,
  onPatchStep,
  onDeleteStep,
  onDelete,
}: {
  node: DraftNode;
  onPatch: (patch: Partial<Pick<DraftNode, "name" | "promptTemplate" | "emitsChecks" | "gateRequirements">>) => void;
  onAddStep: (type: WorkflowStepType) => void;
  onPatchStep: (index: number, patch: { title?: string; prompt?: string }) => void;
  onDeleteStep: (index: number) => void;
  onDelete: () => void;
}) {
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  // gateRequirements edits commit on blur — a half-typed path is not a list.
  const [gates, setGates] = useState(node.gateRequirements.join(", "));

  if (node.type === "trigger") {
    return (
      <div className="wfc-inspector" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Trigger</h3>
        <p className="dim">Ticket claimed. Fixed in v1 — not editable or deletable.</p>
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
        <span className="wfc-pill label">{STEP_TYPE_LABELS[step.type]}</span>
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
          rows={3}
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

/**
 * PROTOTYPE — throwaway, do not ship (ticket 48 canvas editor).
 * Three structurally different takes on the workflow canvas editor, on the
 * real app shell at /?prototype=canvas, switchable via ?variant= (A|B|C) or
 * arrow keys. Sample branched graph is in-memory; Publish/Discard are stubs.
 *   A — free canvas: draggable nodes, bezier edges, floating inspector
 *   B — rail: auto-laid vertical spine, branches as columns, inline inspector
 *   C — outline-first: editable tree on the left, read-only minimap right
 */
import { useEffect, useMemo, useRef, useState } from "react";

type StepType = "search-global" | "search-project" | "search-code" | "search-web" | "action" | "author";
const STEP_TYPES: Record<StepType, string> = {
  "search-global": "Search global knowledge",
  "search-project": "Search project knowledge",
  "search-code": "Search the codebase",
  "search-web": "Web search",
  action: "Perform an action",
  author: "Author a document",
};
interface PStep {
  type: StepType;
  title: string;
  prompt: string;
}
interface PNode {
  id: string;
  name: string;
  kind: "trigger" | "phase";
  emitsChecks?: boolean;
  gateRequirements?: string[];
  prompt?: string;
  steps?: PStep[];
}
interface PEdge {
  from: string;
  to: string;
  label?: string;
}

const NODES: PNode[] = [
  { id: "trigger", name: "Ticket claimed", kind: "trigger" },
  {
    id: "research",
    name: "research",
    kind: "phase",
    prompt: "Investigate the ticket…",
    steps: [
      { type: "search-global", title: "Search global knowledge", prompt: "Query the global knowledge base for prior art on this ticket's topic." },
      { type: "search-project", title: "Search project knowledge", prompt: "Search this project's kb/ docs and past run artifacts." },
      { type: "search-code", title: "Search the codebase", prompt: "Locate the modules and tests this ticket will touch." },
      { type: "search-web", title: "Web search", prompt: "Search the web for library docs and known issues." },
      { type: "author", title: "Write the research doc", prompt: "Synthesize findings into kb/research.md." },
    ],
  },
  { id: "plan", name: "plan", kind: "phase", emitsChecks: true, prompt: "Write the plan and AC checks…" },
  { id: "impact", name: "impact", kind: "phase", prompt: "Judge the blast radius…" },
  {
    id: "implement",
    name: "implement",
    kind: "phase",
    prompt: "Do the work…",
    steps: [
      { type: "action", title: "Build against the plan", prompt: "Implement kb/plan.md's slices in order." },
      { type: "action", title: "Run the AC checks", prompt: "Run the plan's emitted checks locally before finishing." },
    ],
  },
  { id: "dogfood", name: "dogfood", kind: "phase", gateRequirements: ["dogfood/results.json"], prompt: "Use what was built…" },
  { id: "review", name: "review", kind: "phase", prompt: "Self-review the diff…" },
  { id: "document", name: "document", kind: "phase", gateRequirements: ["kb/recap.html"], prompt: "Author the Visual Recap…" },
];
const EDGES: PEdge[] = [
  { from: "trigger", to: "research" },
  { from: "research", to: "plan" },
  { from: "plan", to: "impact" },
  { from: "impact", to: "document", label: "docs-only" },
  { from: "impact", to: "implement", label: "code-change" },
  { from: "implement", to: "dogfood" },
  { from: "dogfood", to: "review" },
  { from: "review", to: "document" },
];
const byId = (id: string): PNode => NODES.find((n) => n.id === id)!;

/* ---------------- shared bits ---------------- */

function NodeBadges({ node }: { node: PNode }) {
  return (
    <span className="wfp-badges">
      {node.steps && node.steps.length > 0 && (
        <span className="wfp-pill label">{node.steps.length} steps</span>
      )}
      {node.emitsChecks && <span className="wfp-pill ok">checks</span>}
      {node.gateRequirements?.map((g) => (
        <span key={g} className="wfp-pill info" title={`owes ${g}`}>
          owes
        </span>
      ))}
    </span>
  );
}

function Inspector({ node, floating }: { node: PNode; floating?: boolean }) {
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  // Reset drill-in when the selected node changes.
  useEffect(() => {
    setOpenStep(null);
    setAdding(false);
  }, [node.id]);

  if (node.kind === "trigger") {
    return (
      <div className={`wfp-inspector${floating ? " floating" : ""}`}>
        <h3>Trigger</h3>
        <p className="dim">Ticket claimed. Fixed in v1 — not editable or deletable.</p>
      </div>
    );
  }

  const steps = node.steps ?? [];
  const step = openStep !== null ? steps[openStep] : null;

  if (step) {
    return (
      <div className={`wfp-inspector${floating ? " floating" : ""}`}>
        <button type="button" className="wfp-back" onClick={() => setOpenStep(null)}>
          ← {node.name}
        </button>
        <h3>{step.title}</h3>
        <span className="wfp-pill label">{STEP_TYPES[step.type]}</span>
        <label>
          Title
          <input defaultValue={step.title} />
        </label>
        <label>
          Prompt
          <textarea defaultValue={step.prompt} rows={5} />
        </label>
        <p className="dim wfp-hint">
          Steps compile into this stage's single session prompt — they never run on their own.
        </p>
      </div>
    );
  }

  return (
    <div className={`wfp-inspector${floating ? " floating" : ""}`}>
      <h3>{node.name}</h3>
      <label>
        Name
        <input defaultValue={node.name} />
      </label>
      <label>
        Prompt template
        <textarea defaultValue={node.prompt} rows={3} />
      </label>
      <div className="wfp-steps">
        <span className="wfp-steps-head">Steps</span>
        {steps.length === 0 && <span className="dim wfp-hint">No steps — the stage prompt runs alone.</span>}
        {steps.map((s, i) => (
          <button key={i} type="button" className="wfp-step-row" onClick={() => setOpenStep(i)}>
            <span className="wfp-step-num">{i + 1}</span>
            <span className="wfp-step-title">{s.title}</span>
            <span className="wfp-pill label">{STEP_TYPES[s.type]}</span>
          </button>
        ))}
        {adding ? (
          <div className="wfp-step-menu">
            <span className="wfp-steps-head">Add step</span>
            {(Object.keys(STEP_TYPES) as StepType[]).map((t) => (
              <button key={t} type="button" className="wfp-step-row" onClick={() => setAdding(false)}>
                <span className="wfp-step-title">{STEP_TYPES[t]}</span>
                <span className="wfp-step-plus">+</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="wfp-add-step" onClick={() => setAdding(true)}>
            + Add step
          </button>
        )}
      </div>
      <label className="row">
        <input type="checkbox" defaultChecked={node.emitsChecks} /> Emits AC checks
      </label>
      <label>
        Owes artifacts
        <input defaultValue={node.gateRequirements?.join(", ") ?? ""} placeholder="kb/recap.html" />
      </label>
    </div>
  );
}

function DraftChrome({ placement }: { placement: "top" | "bottom" }) {
  return (
    <div className={`wfp-chrome ${placement}`}>
      <span className="wfp-pill warn">Draft — unpublished changes</span>
      <span className="wfp-chrome-actions">
        <button type="button">Discard</button>
        <button type="button" className="primary">
          Publish
        </button>
      </span>
    </div>
  );
}

/* ---------------- builder chat (Lindy-style side panel) ---------------- */

function BuilderChat({ onScriptedEdit }: { onScriptedEdit: () => void }) {
  const [messages, setMessages] = useState<{ role: "ai" | "user"; text: string }[]>([
    {
      role: "ai",
      text: "I can edit this workflow — its stages, steps, and branches. Try: \"add a security stage after review.\"",
    },
  ]);
  const [input, setInput] = useState("");
  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((m) => [
      ...m,
      { role: "user", text },
      {
        role: "ai",
        text: "Added the security stage after review and rewired document to follow it. Publish when you're happy — nothing runs until you do.",
      },
    ]);
    onScriptedEdit();
  };
  return (
    <aside className="wfp-chat">
      <header className="wfp-chat-head">Workflow builder</header>
      <div className="wfp-chat-msgs">
        {messages.map((m, i) => (
          <div key={i} className={`wfp-chat-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>
      <div className="wfp-chat-input">
        <textarea
          rows={2}
          placeholder="Describe a change…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="primary" onClick={send}>
          Send
        </button>
      </div>
    </aside>
  );
}

/* ---------------- Variant A: free canvas ---------------- */

const A_POS: Record<string, { x: number; y: number }> = {
  trigger: { x: 340, y: 20 },
  research: { x: 340, y: 120 },
  plan: { x: 340, y: 220 },
  impact: { x: 340, y: 320 },
  implement: { x: 560, y: 440 },
  dogfood: { x: 560, y: 540 },
  review: { x: 560, y: 640 },
  document: { x: 240, y: 740 },
};
const NODE_W = 190;
const NODE_H = 56;

function VariantA() {
  const [pos, setPos] = useState(A_POS);
  const [sel, setSel] = useState<string | null>("impact");
  const [nodes, setNodes] = useState(NODES);
  const [edges, setEdges] = useState(EDGES);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const pan = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

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
  }, []);

  const zoomBy = (factor: number) =>
    setView((v) => {
      const el = canvasRef.current;
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      const scale = Math.min(2.5, Math.max(0.25, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  // Scripted chat edit: insert a security stage between review and document.
  const addSecurityStage = () => {
    if (nodes.some((n) => n.id === "security")) return;
    setNodes((ns) => [
      ...ns,
      {
        id: "security",
        name: "security-review",
        kind: "phase" as const,
        prompt: "Audit the diff for injection, authz, and secret handling…",
        steps: [
          { type: "search-code" as const, title: "Scan the diff for risky surfaces", prompt: "Find input handling, authz checks, and secrets touched by this change." },
          { type: "author" as const, title: "Write the security note", prompt: "Record findings in kb/security-review.md." },
        ],
      },
    ]);
    setEdges((es) => [
      ...es.filter((e) => !(e.from === "review" && e.to === "document")),
      { from: "review", to: "security" },
      { from: "security", to: "document" },
    ]);
    setPos((p) => ({ ...p, security: { x: 560, y: 740 } }));
    setSel("security");
  };

  const onDown = (id: string, e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { id, startX: e.clientX, startY: e.clientY, origX: pos[id]!.x, origY: pos[id]!.y };
    (e.target as Element).setPointerCapture(e.pointerId);
    setSel(id);
  };
  const onPanDown = (e: React.PointerEvent) => {
    pan.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const dx = (e.clientX - d.startX) / view.scale;
      const dy = (e.clientY - d.startY) / view.scale;
      setPos((p) => ({ ...p, [d.id]: { x: d.origX + dx, y: d.origY + dy } }));
      return;
    }
    const p = pan.current;
    if (p) setView((v) => ({ ...v, x: p.origX + (e.clientX - p.startX), y: p.origY + (e.clientY - p.startY) }));
  };
  const onUp = () => {
    drag.current = null;
    pan.current = null;
  };

  return (
    <div className="wfp-a-wrap">
      <BuilderChat onScriptedEdit={addSecurityStage} />
      <div
        ref={canvasRef}
        className="wfp-canvas"
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${18 * view.scale}px ${18 * view.scale}px` }}
        onPointerDown={onPanDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
      <DraftChrome placement="top" />
      <div
        className="wfp-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
      <svg className="wfp-edges">
        {edges.map((e) => {
          const a = pos[e.from]!;
          const b = pos[e.to]!;
          const x1 = a.x + NODE_W / 2;
          const y1 = a.y + NODE_H;
          const x2 = b.x + NODE_W / 2;
          const y2 = b.y;
          const my = (y1 + y2) / 2;
          return (
            <g key={`${e.from}-${e.to}`}>
              <path d={`M ${x1} ${y1} L ${x2} ${y2}`} className="wfp-edge-path" />
              {e.label && (
                <foreignObject x={(x1 + x2) / 2 - 55} y={my - 12} width="110" height="24">
                  <span className="wfp-pill label">{e.label}</span>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((n) => (
        <div
          key={n.id}
          className={`wfp-node${sel === n.id ? " selected" : ""}${n.kind === "trigger" ? " trigger" : ""}`}
          style={{ left: pos[n.id]!.x, top: pos[n.id]!.y, width: NODE_W, height: NODE_H }}
          onPointerDown={(e) => onDown(n.id, e)}
        >
          <span className="wfp-node-name">{n.name}</span>
          <NodeBadges node={n} />
        </div>
      ))}
      </div>
      {sel && <Inspector key={sel} node={nodes.find((n) => n.id === sel)!} floating />}
      <div className="wfp-zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" className="wfp-zoom-pct" onClick={() => setView({ x: 0, y: 0, scale: 1 })} title="Reset view">
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.25)}>+</button>
      </div>
      </div>
    </div>
  );
}

/* ---------------- Variant B: vertical rail ---------------- */

function RailNode({ n, sel, setSel }: { n: PNode; sel: string | null; setSel: (s: string) => void }) {
  return (
    <div>
      <button
        type="button"
        className={`wfp-node rail${sel === n.id ? " selected" : ""}${n.kind === "trigger" ? " trigger" : ""}`}
        onClick={() => setSel(n.id)}
      >
        <span className="wfp-node-name">{n.name}</span>
        <NodeBadges node={n} />
      </button>
      {sel === n.id && <Inspector node={n} />}
    </div>
  );
}

function VariantB() {
  const [sel, setSel] = useState<string | null>("impact");
  const spine = ["trigger", "research", "plan", "impact"];
  const codePath = ["implement", "dogfood", "review"];
  return (
    <div className="wfp-rail-wrap">
      <div className="wfp-rail">
        {spine.map((id) => (
          <RailNode key={id} n={byId(id)} sel={sel} setSel={setSel} />
        ))}
        <div className="wfp-rail-branches">
          <div className="wfp-rail-branch">
            <span className="wfp-pill label">docs-only</span>
            <div className="wfp-rail-skip dim">skips build — straight to document</div>
          </div>
          <div className="wfp-rail-branch">
            <span className="wfp-pill label">code-change</span>
            {codePath.map((id) => (
              <RailNode key={id} n={byId(id)} sel={sel} setSel={setSel} />
            ))}
          </div>
        </div>
        <div className="wfp-rail-merge dim">⑃ paths merge</div>
        <RailNode n={byId("document")} sel={sel} setSel={setSel} />
      </div>
      <DraftChrome placement="bottom" />
    </div>
  );
}

/* ---------------- Variant C: outline + minimap ---------------- */

const C_ROWS: { id: string; depth: number; branch?: string }[] = [
  { id: "trigger", depth: 0 },
  { id: "research", depth: 0 },
  { id: "plan", depth: 0 },
  { id: "impact", depth: 0 },
  { id: "document", depth: 1, branch: "docs-only" },
  { id: "implement", depth: 1, branch: "code-change" },
  { id: "dogfood", depth: 1 },
  { id: "review", depth: 1 },
  { id: "document", depth: 0 },
];

function VariantC() {
  const [sel, setSel] = useState<string | null>("impact");
  const mini = useMemo(
    () =>
      Object.entries(A_POS).map(([id, p]) => ({
        id,
        x: p.x / 5,
        y: p.y / 5,
      })),
    [],
  );
  return (
    <div className="wfp-outline-wrap">
      <div className="wfp-outline">
        <div className="wfp-chrome top static">
          <span className="wfp-pill warn">Draft</span>
          <span className="wfp-chrome-actions">
            <button type="button">Discard</button>
            <button type="button" className="primary">
              Publish
            </button>
          </span>
        </div>
        {C_ROWS.map((r, i) => {
          const n = byId(r.id);
          return (
            <div key={i} style={{ paddingLeft: r.depth * 24 }}>
              {r.branch && <div className="wfp-outline-branch dim">↳ {r.branch}</div>}
              <button
                type="button"
                className={`wfp-outline-row${sel === n.id ? " selected" : ""}`}
                onClick={() => setSel(n.id)}
              >
                <span className="wfp-node-name">{n.name}</span>
                <NodeBadges node={n} />
              </button>
              {sel === n.id && r.depth === 0 && i !== C_ROWS.length - 1 && <Inspector node={n} />}
            </div>
          );
        })}
      </div>
      <div className="wfp-minimap">
        <svg viewBox="0 0 180 170">
          {EDGES.map((e) => {
            const a = mini.find((m) => m.id === e.from)!;
            const b = mini.find((m) => m.id === e.to)!;
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={a.x + 19}
                y1={a.y + 8}
                x2={b.x + 19}
                y2={b.y + 4}
                className="wfp-mini-edge"
              />
            );
          })}
          {mini.map((m) => (
            <rect
              key={m.id}
              x={m.x}
              y={m.y}
              width={38}
              height={9}
              rx={2}
              className={`wfp-mini-node${sel === m.id ? " selected" : ""}`}
              onClick={() => setSel(m.id)}
            />
          ))}
        </svg>
        <p className="dim">read-only minimap — outline is the editor</p>
      </div>
    </div>
  );
}

/* ---------------- switcher ---------------- */

const VARIANTS = [
  { key: "A", name: "Free canvas", el: <VariantA /> },
  { key: "B", name: "Rail", el: <VariantB /> },
  { key: "C", name: "Outline + minimap", el: <VariantC /> },
];

export function WorkflowCanvasPrototype() {
  const [variant, setVariant] = useState(
    () => new URLSearchParams(location.search).get("variant") ?? "A",
  );
  const idx = Math.max(0, VARIANTS.findIndex((v) => v.key === variant));
  const go = (d: number) => {
    const next = VARIANTS[(idx + d + VARIANTS.length) % VARIANTS.length]!.key;
    const u = new URL(location.href);
    u.searchParams.set("variant", next);
    history.replaceState(null, "", u);
    setVariant(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="wfp-root">
      <style>{PROTO_CSS}</style>
      {VARIANTS[idx]!.el}
      {!import.meta.env.PROD && (
        <div className="wfp-switcher">
          <button type="button" onClick={() => go(-1)}>
            ←
          </button>
          <span>
            {VARIANTS[idx]!.key} — {VARIANTS[idx]!.name}
          </span>
          <button type="button" onClick={() => go(1)}>
            →
          </button>
        </div>
      )}
    </div>
  );
}

const PROTO_CSS = `
/* Lindy-style canvas: kill the .main card, dotted grid instead */
.main:has(.wfp-root) { background: transparent; box-shadow: none; border-radius: 0; margin: 0; }
.wfp-root { position: relative; flex: 1; min-height: 0; overflow: auto; font-size: var(--fs-base); }
.wfp-canvas {
  background-image: radial-gradient(var(--border-strong) 1px, transparent 1px);
  background-size: 18px 18px;
}
.wfp-pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--radius-full); font-size: var(--fs-xs); white-space: nowrap; }
.wfp-pill.ok { background: var(--ok-bg); color: var(--ok-fg); box-shadow: inset 0 0 0 1px var(--ok-border); }
.wfp-pill.info { background: var(--info-bg); color: var(--info-fg); box-shadow: inset 0 0 0 1px var(--info-border); }
.wfp-pill.warn { background: var(--warn-bg); color: var(--warn-fg); box-shadow: inset 0 0 0 1px var(--warn-border); }
.wfp-pill.label { background: var(--surface-raised); color: var(--text-muted); box-shadow: var(--shadow-raised); }
.wfp-node { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-raised); cursor: grab; user-select: none; border: none; font: inherit; color: var(--text-base); text-align: left; }
.wfp-node.selected { box-shadow: var(--shadow-floating), 0 0 0 2px var(--border-focus); }
.wfp-node.trigger { background: var(--info-bg); color: var(--info-fg); }
.wfp-node-name { font-weight: 500; }
.wfp-badges { display: inline-flex; gap: 4px; margin-left: auto; }
.wfp-canvas { position: relative; overflow: hidden; cursor: grab; touch-action: none; }
.wfp-canvas:active { cursor: grabbing; }
.wfp-world { position: absolute; inset: 0; transform-origin: 0 0; }
.wfp-canvas .wfp-node { position: absolute; }
.wfp-zoom { position: absolute; bottom: 18px; right: 18px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: var(--radius-full); background: var(--surface-raised); box-shadow: var(--shadow-floating); z-index: 6; }
.wfp-zoom button { font: inherit; font-size: var(--fs-sm); border: none; background: none; color: var(--text-base); cursor: pointer; padding: 2px 8px; border-radius: var(--radius-full); }
.wfp-zoom button:hover { background: var(--overlay-hover); }
.wfp-zoom-pct { min-width: 44px; text-align: center; color: var(--text-muted); }
.wfp-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.wfp-edge-path { fill: none; stroke: var(--border-strong); stroke-width: 1.5; }
.wfp-inspector { background: var(--surface-panel); box-shadow: var(--shadow-raised); border-radius: var(--radius-lg); padding: 14px; display: flex; flex-direction: column; gap: 10px; margin: 8px 0; }
.wfp-inspector.floating { position: fixed; top: 96px; right: 24px; width: 280px; box-shadow: var(--shadow-overlay); z-index: 5; }
.wfp-inspector h3 { margin: 0; font-size: var(--fs-base); }
.wfp-inspector label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); }
.wfp-inspector label.row { flex-direction: row; align-items: center; gap: 8px; }
.wfp-inspector > .wfp-pill { align-self: flex-start; }
.wfp-inspector input, .wfp-inspector textarea { font: inherit; color: var(--text-base); background: var(--surface-input); border: none; box-shadow: var(--shadow-raised); border-radius: var(--radius-md); padding: 6px 8px; }
.wfp-inspector input:focus-visible, .wfp-inspector textarea:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--border-focus); }
.wfp-chrome { display: flex; align-items: center; gap: 12px; justify-content: space-between; padding: 10px 16px; z-index: 6; }
.wfp-chrome.top { position: sticky; top: 0; }
.wfp-chrome.top.static { position: static; padding: 0 0 12px; }
.wfp-chrome.bottom { position: sticky; bottom: 0; background: var(--bg-app); }
.wfp-chrome-actions { display: flex; gap: 8px; }
.wfp-chrome button { font: inherit; font-size: var(--fs-sm); padding: 5px 14px; border-radius: var(--radius-md); border: none; background: var(--surface-raised); box-shadow: var(--shadow-button); color: var(--text-base); cursor: pointer; }
.wfp-chrome button:hover { background: var(--surface-raised-hover); }
.wfp-chrome button.primary { background: var(--info-bg); color: var(--info-fg); box-shadow: inset 0 0 0 1px var(--info-border); }
.wfp-steps { display: flex; flex-direction: column; gap: 6px; }
.wfp-steps-head { font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-faint); }
.wfp-step-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: var(--radius-md); background: var(--surface-sunken); border: none; font: inherit; font-size: var(--fs-sm); color: var(--text-base); cursor: pointer; text-align: left; }
.wfp-step-row:hover { background: var(--overlay-hover); }
.wfp-step-num { font-size: var(--fs-xs); color: var(--text-faint); min-width: 12px; }
.wfp-step-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wfp-step-plus { color: var(--text-faint); }
.wfp-step-menu { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--radius-md); background: var(--surface-sunken-faint); box-shadow: inset 0 0 0 1px var(--border-muted); }
.wfp-add-step { align-self: flex-start; font: inherit; font-size: var(--fs-sm); color: var(--text-accent); background: none; border: none; cursor: pointer; padding: 2px 0; }
.wfp-back { align-self: flex-start; font: inherit; font-size: var(--fs-sm); color: var(--text-accent); background: none; border: none; cursor: pointer; padding: 0; }
.wfp-hint { font-size: var(--fs-xs); }
.wfp-a-wrap { display: flex; height: 100%; min-height: 0; }
.wfp-a-wrap .wfp-canvas { flex: 1; overflow: auto; }
.wfp-chat { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; margin: 12px; border-radius: var(--radius-lg); background: var(--surface-panel); box-shadow: var(--shadow-floating); overflow: hidden; }
.wfp-chat-head { padding: 10px 14px; font-weight: 600; font-size: var(--fs-sm); box-shadow: inset 0 -1px 0 var(--border-muted); }
.wfp-chat-msgs { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.wfp-chat-msg { max-width: 90%; padding: 8px 10px; border-radius: var(--radius-lg); font-size: var(--fs-sm); line-height: 1.45; }
.wfp-chat-msg.ai { background: var(--surface-sunken); align-self: flex-start; }
.wfp-chat-msg.user { background: var(--info-bg); color: var(--info-fg); align-self: flex-end; }
.wfp-chat-input { display: flex; gap: 8px; padding: 10px; box-shadow: inset 0 1px 0 var(--border-muted); }
.wfp-chat-input textarea { flex: 1; resize: none; font: inherit; font-size: var(--fs-sm); color: var(--text-base); background: var(--surface-input); border: none; box-shadow: var(--shadow-raised); border-radius: var(--radius-md); padding: 6px 8px; }
.wfp-chat-input textarea:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--border-focus); }
.wfp-chat-input button.primary { font: inherit; font-size: var(--fs-sm); padding: 5px 12px; border-radius: var(--radius-md); border: none; background: var(--info-bg); color: var(--info-fg); box-shadow: inset 0 0 0 1px var(--info-border); cursor: pointer; align-self: flex-end; }
.wfp-rail-wrap { max-width: 560px; margin: 0 auto; padding: 24px 0 60px; }
.wfp-rail { display: flex; flex-direction: column; gap: 14px; }
.wfp-rail .wfp-node.rail { width: 100%; height: 52px; cursor: pointer; }
.wfp-rail-branches { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 4px; border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--border-base); background: var(--surface-sunken-faint); }
.wfp-rail-branch { display: flex; flex-direction: column; gap: 10px; padding: 10px; }
.wfp-rail-skip { font-size: var(--fs-sm); padding: 14px 6px; }
.wfp-rail-merge { text-align: center; font-size: var(--fs-sm); }
.wfp-outline-wrap { display: grid; grid-template-columns: 1fr 240px; gap: 24px; max-width: 820px; margin: 0 auto; padding: 24px 0 60px; }
.wfp-outline { display: flex; flex-direction: column; gap: 6px; }
.wfp-outline-row { display: flex; width: 100%; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-raised); box-shadow: var(--shadow-raised); border: none; font: inherit; color: var(--text-base); cursor: pointer; }
.wfp-outline-row.selected { box-shadow: var(--shadow-raised), 0 0 0 2px var(--border-focus); }
.wfp-outline-branch { font-size: var(--fs-sm); padding: 6px 0 2px; }
.wfp-minimap { position: sticky; top: 80px; align-self: start; background: var(--surface-panel); border-radius: var(--radius-lg); box-shadow: var(--shadow-raised); padding: 12px; font-size: var(--fs-xs); }
.wfp-mini-node { fill: var(--text-faint); cursor: pointer; }
.wfp-mini-node.selected { fill: var(--text-accent); }
.wfp-mini-edge { stroke: var(--border-strong); }
.wfp-switcher { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-radius: var(--radius-full); background: var(--contrast-bg); color: var(--contrast-fg); box-shadow: var(--shadow-overlay); z-index: 50; font-size: var(--fs-base); }
.wfp-switcher button { background: none; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0 4px; }
`;

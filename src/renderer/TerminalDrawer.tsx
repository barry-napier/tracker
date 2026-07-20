import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "./icons";

/** The preload's PTY bridge; absent when running the renderer outside Electron. */
interface TermApi {
  spawn: (opts: { cols: number; rows: number }) => Promise<number>;
  input: (id: number, data: string) => void;
  resize: (id: number, cols: number, rows: number) => void;
  kill: (id: number) => void;
  onData: (handler: (payload: { id: number; data: string }) => void) => () => void;
  onExit: (handler: (payload: { id: number; exitCode: number }) => void) => () => void;
}

function termApi(): TermApi | undefined {
  return (window as { tracker?: { term?: TermApi } }).tracker?.term;
}

/** xterm's colors come from the app theme, re-read whenever the drawer opens. */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim() || undefined;
  return {
    background: read("--bg-app"),
    foreground: read("--text-base"),
    cursor: read("--text-base"),
    selectionBackground: read("--overlay-hover"),
  };
}

/*
 * Panes form a binary-ish split tree: splitting the focused pane replaces its
 * leaf with a split node; splitting again in the same direction just inserts a
 * sibling. "row" lays panes side by side (Split Horizontally), "col" stacks
 * them (Split Vertically).
 */
type SplitDir = "row" | "col";
type TermNode =
  | { type: "pane"; id: number }
  | { type: "split"; dir: SplitDir; children: TermNode[] };

function splitPane(node: TermNode, target: number, dir: SplitDir, newId: number): TermNode {
  if (node.type === "pane") {
    if (node.id !== target) return node;
    return { type: "split", dir, children: [node, { type: "pane", id: newId }] };
  }
  if (node.dir === dir) {
    const at = node.children.findIndex((c) => c.type === "pane" && c.id === target);
    if (at !== -1) {
      const children = [...node.children];
      children.splice(at + 1, 0, { type: "pane", id: newId });
      return { ...node, children };
    }
  }
  return { ...node, children: node.children.map((c) => splitPane(c, target, dir, newId)) };
}

function removePane(node: TermNode, target: number): TermNode | null {
  if (node.type === "pane") return node.id === target ? null : node;
  const children = node.children
    .map((c) => removePane(c, target))
    .filter((c): c is TermNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

function firstPaneId(node: TermNode): number {
  return node.type === "pane" ? node.id : firstPaneId(node.children[0]!);
}

/**
 * One xterm + PTY, alive for the pane's lifetime — hiding the drawer does not
 * end the shell session; removing the pane from the tree does. The PTY spawns
 * lazily on first open; if the shell exits (ctrl-d), the next open spawns a
 * fresh one.
 */
export function TermPane({
  open,
  active,
  onFocus,
}: {
  open: boolean;
  active: boolean;
  onFocus: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const spawningRef = useRef(false);

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      theme: themeColors(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    const offData = termApi()?.onData(({ id, data }) => {
      if (id === ptyIdRef.current) term.write(data);
    });
    const offExit = termApi()?.onExit(({ id, exitCode }) => {
      if (id !== ptyIdRef.current) return;
      ptyIdRef.current = null;
      term.writeln(`\r\n[shell exited with code ${exitCode}]`);
    });
    const onInput = term.onData((data) => {
      if (ptyIdRef.current !== null) termApi()?.input(ptyIdRef.current, data);
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ptyIdRef.current !== null) termApi()?.resize(ptyIdRef.current, cols, rows);
    });

    return () => {
      onInput.dispose();
      onResize.dispose();
      offData?.();
      offExit?.();
      if (ptyIdRef.current !== null) termApi()?.kill(ptyIdRef.current);
      ptyIdRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Opening: refit to the now-visible box, (re)spawn a shell if none is
  // running, focus if this is the active pane. The fit waits a frame so the
  // slide-open (or a fresh split) has real dimensions.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const api = termApi();
      if (!term) return;
      term.options.theme = themeColors();
      fitRef.current?.fit();
      if (api && ptyIdRef.current === null && !spawningRef.current) {
        spawningRef.current = true;
        void api
          .spawn({ cols: term.cols, rows: term.rows })
          .then((id) => {
            ptyIdRef.current = id;
          })
          .finally(() => {
            spawningRef.current = false;
          });
      } else if (!api) {
        term.writeln("Terminal is only available inside the Tracker app.");
      }
      if (active) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active]);

  // Keep cols/rows honest across window and split resizes while visible.
  useEffect(() => {
    if (!open || !hostRef.current) return;
    const observer = new ResizeObserver(() => fitRef.current?.fit());
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [open]);

  return <div className="term-pane" ref={hostRef} onMouseDownCapture={onFocus} />;
}

/**
 * The drawer: mounted once by the Shell and kept alive across toggles.
 * Hosts a splittable set of terminal panes and the toolbar driving them
 * (⌘D / ⇧⌘D split, ⌘N new pane, ⌘W close pane — closing the last pane
 * closes the drawer).
 */
export function TerminalDrawer({ open, onClose }: { open: boolean; onClose?: () => void }) {
  const nextIdRef = useRef(1);
  const [root, setRoot] = useState<TermNode>({ type: "pane", id: 0 });
  const [focused, setFocused] = useState(0);

  const split = (dir: SplitDir) => {
    const id = nextIdRef.current++;
    setRoot((r) => splitPane(r, focused, dir, id));
    setFocused(id);
  };

  const newTerm = () => {
    const id = nextIdRef.current++;
    setRoot((r) =>
      r.type === "split" && r.dir === "row"
        ? { ...r, children: [...r.children, { type: "pane", id }] }
        : { type: "split", dir: "row", children: [r, { type: "pane", id }] },
    );
    setFocused(id);
  };

  const closePane = () => {
    const next = removePane(root, focused);
    if (next === null) {
      // Last pane: swap in a fresh one (unmount kills the old PTY) and close.
      setRoot({ type: "pane", id: nextIdRef.current++ });
      onClose?.();
      return;
    }
    setRoot(next);
    setFocused(firstPaneId(next));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "d") {
        e.preventDefault();
        split(e.shiftKey ? "col" : "row");
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        newTerm();
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        closePane();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const renderNode = (node: TermNode): React.ReactNode => {
    if (node.type === "pane") {
      return (
        <TermPane
          key={node.id}
          open={open}
          active={node.id === focused}
          onFocus={() => setFocused(node.id)}
        />
      );
    }
    return (
      <div key={node.children.map(firstPaneId).join("-")} className={`term-split ${node.dir}`}>
        {node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <div className={open ? "term-drawer open" : "term-drawer"} aria-hidden={!open}>
      <div className="term-toolbar">
        <button
          type="button"
          className="icon-btn"
          title="Split Terminal Horizontally (⌘D)"
          onClick={() => split("row")}
        >
          <Icon name="split-horizontal" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Split Terminal Vertically (⇧⌘D)"
          onClick={() => split("col")}
        >
          <Icon name="split-vertical" size={16} />
        </button>
        <button type="button" className="icon-btn" title="New Terminal (⌘N)" onClick={newTerm}>
          <Icon name="plus-small" size={16} />
        </button>
        <button type="button" className="icon-btn" title="Close Terminal (⌘W)" onClick={closePane}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      <div className="term-body">{renderNode(root)}</div>
    </div>
  );
}

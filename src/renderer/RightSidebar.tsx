import { useEffect, useRef, useState } from "react";
import { apiGet, errorMessage } from "./api";
import { Icon, type IconName } from "./icons";
import { TermPane } from "./TerminalDrawer.tsx";

/** The slice of Electron's WebviewTag the Browser surface drives. */
type WebviewEl = HTMLElement & {
  src: string;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  setZoomLevel(level: number): void;
};

/** Session-level ops the <webview> element can't do; absent in browser dev. */
const browserApi = (
  window as {
    tracker?: { browser?: { clearCache(): Promise<void>; clearCookies(): Promise<void> } };
  }
).tracker?.browser;

/** True in the packaged app, where the Browser surface is a real <webview>.
 *  Sites that refuse to be iframed (GitHub) only render there, so callers
 *  gate "open in sidebar" affordances on this. */
export const hasEmbeddedBrowser = browserApi !== undefined;

/** An external ask to show a URL in the Browser surface; `tick` distinguishes
 *  repeat asks for the same URL (state alone couldn't re-trigger). */
export interface BrowseRequest {
  url: string;
  tick: number;
}

type Surface = "browser" | "terminal" | "files" | "diff";

const SURFACES: {
  key: Surface;
  icon: IconName;
  title: string;
  desc: string;
  disabled?: boolean;
}[] = [
  { key: "browser", icon: "globe", title: "Browser", desc: "Open a local app or URL." },
  { key: "terminal", icon: "terminal", title: "Terminal", desc: "Start a shell in this workspace." },
  {
    key: "files",
    icon: "copy",
    title: "Files",
    desc: "Browse and read workspace files.",
  },
  {
    key: "diff",
    icon: "review",
    title: "Diff",
    desc: "Review uncommitted changes.",
  },
];

type LocalServer = { port: number; command: string };

/* ---------------------------------------------------------------- Files -- */

type TreeDir = { name: string; path: string; dirs: Map<string, TreeDir>; files: string[] };

function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(p);
  }
  return root;
}

/** Chains of lone directories render as one row: `.agents / skills`. */
function compress(dir: TreeDir): { label: string; dir: TreeDir } {
  let label = dir.name;
  while (dir.dirs.size === 1 && dir.files.length === 0) {
    dir = dir.dirs.values().next().value!;
    label = `${label} / ${dir.name}`;
  }
  return { label, dir };
}

const EXT_BADGES: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "#3178c6" },
  tsx: { label: "TS", color: "#0e7490" },
  js: { label: "JS", color: "#b7a219" },
  jsx: { label: "JS", color: "#b7a219" },
  json: { label: "{}", color: "#8a8a8a" },
  md: { label: "M↓", color: "#3d9a50" },
  css: { label: "#", color: "#7c5cbf" },
  html: { label: "<>", color: "#c4622d" },
  svg: { label: "SVG", color: "#c4622d" },
  sh: { label: "$", color: "#6b7280" },
  yml: { label: "Y", color: "#a04b9d" },
  yaml: { label: "Y", color: "#a04b9d" },
};

/** Extensions shiki should highlight; anything else stays a plain <pre>. */
const HIGHLIGHT_LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  cjs: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  svg: "xml",
  xml: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  py: "python",
  rs: "rust",
  go: "go",
  sql: "sql",
};

const HIGHLIGHT_LIMIT = 200 * 1024;

/**
 * Lazy shiki singleton on the JavaScript regex engine — the default Oniguruma
 * engine is wasm, which the renderer's CSP (`default-src 'self'`, no
 * wasm-unsafe-eval) rightly refuses. Grammars load on demand per language.
 */
let highlighterPromise: Promise<import("shiki").Highlighter> | null = null;
function getHighlighter(): Promise<import("shiki").Highlighter> {
  highlighterPromise ??= Promise.all([
    import("shiki"),
    import("shiki/engine/javascript"),
  ]).then(([shiki, js]) =>
    shiki.createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [],
      engine: js.createJavaScriptRegexEngine(),
    }),
  );
  return highlighterPromise;
}

function extOf(path: string): string {
  const name = path.split("/").pop()!;
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

function FileBadge({ name }: { name: string }) {
  const badge = EXT_BADGES[extOf(name)];
  return (
    <span className="rs-file-badge" style={badge ? { color: badge.color } : undefined}>
      {badge?.label ?? "·"}
    </span>
  );
}

function FilesSurface({ projectId }: { projectId: number | null }) {
  const [tree, setTree] = useState<{ root: string; files: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<{ path: string; body: string; plain?: boolean } | null>(
    null,
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Highlight lazily: shiki (and each grammar/theme) loads as its own chunk
  // on first use, so the tree itself costs nothing extra. Plain <pre> shows
  // until the highlight lands — or forever, for unknown/huge/error content.
  useEffect(() => {
    setHighlighted(null);
    if (!viewing || viewing.plain || viewing.body.length > HIGHLIGHT_LIMIT) return;
    const lang = HIGHLIGHT_LANGS[extOf(viewing.path)];
    if (!lang) return;
    let cancelled = false;
    void getHighlighter()
      .then(async (highlighter) => {
        await highlighter.loadLanguage(lang as import("shiki").BundledLanguage);
        return highlighter.codeToHtml(viewing.body, {
          lang,
          theme:
            document.documentElement.dataset.colorScheme === "dark"
              ? "github-dark"
              : "github-light",
        });
      })
      .then((html) => !cancelled && setHighlighted(html))
      .catch((e: unknown) => {
        // Plain <pre> is already showing — fine as fallback, but say why.
        console.error("shiki highlight failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [viewing]);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    setError(null);
    apiGet<{ root: string; files: string[] }>(`/api/projects/${projectId}/files`)
      .then((t) => !cancelled && setTree(t))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick]);

  if (projectId === null) return <p className="rs-hint">Open a project to browse its files.</p>;
  if (error) return <p className="rs-hint">{error}</p>;
  if (!tree) return <p className="rs-hint">Reading the repository…</p>;

  const openFile = (path: string) => {
    void apiGet<{ content?: string; error?: string }>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`,
    )
      .then((r) =>
        setViewing(
          r.content === undefined
            ? { path, body: `(${r.error ?? "unreadable"})`, plain: true }
            : r.content === ""
              ? { path, body: "(empty file)", plain: true }
              : { path, body: r.content },
        ),
      )
      .catch((e) => setViewing({ path, body: `(${errorMessage(e)})`, plain: true }));
  };

  const fileRow = (path: string, indent: number) => {
    const name = path.split("/").pop()!;
    return (
      <button
        key={path}
        type="button"
        className="rs-tree-row"
        style={{ paddingLeft: indent * 14 + 8 }}
        title={path}
        onClick={() => openFile(path)}
      >
        <FileBadge name={name} />
        <span className="rs-tree-name">{name}</span>
      </button>
    );
  };

  const renderDir = (child: TreeDir, indent: number): React.ReactNode => {
    const { label, dir } = compress(child);
    const isOpen = expanded.has(dir.path);
    return (
      <div key={dir.path}>
        <button
          type="button"
          className="rs-tree-row rs-tree-dir"
          style={{ paddingLeft: indent * 14 + 8 }}
          onClick={() =>
            setExpanded((prev) => {
              const next = new Set(prev);
              isOpen ? next.delete(dir.path) : next.add(dir.path);
              return next;
            })
          }
        >
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={13} />
          <span className="rs-tree-name">{label}</span>
        </button>
        {isOpen && (
          <>
            {[...dir.dirs.values()].map((d) => renderDir(d, indent + 1))}
            {dir.files.map((f) => fileRow(f, indent + 1))}
          </>
        )}
      </div>
    );
  };

  if (viewing) {
    return (
      <div className="rs-files">
        <div className="rs-files-head">
          <button
            type="button"
            className="icon-btn"
            title="Back to files"
            onClick={() => setViewing(null)}
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span className="rs-files-title" title={viewing.path}>
            {viewing.path}
          </span>
        </div>
        {highlighted ? (
          <div
            className="rs-file-body rs-file-code"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre className="rs-file-body">{viewing.body}</pre>
        )}
      </div>
    );
  }

  const matches = query.trim()
    ? tree.files.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase()))
    : null;

  return (
    <div className="rs-files">
      <div className="rs-files-head">
        <span className="rs-files-title">{tree.root}</span>
        <span className="rs-files-count">
          {tree.files.length} {tree.files.length === 1 ? "file" : "files"}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Refresh"
          onClick={() => setRefreshTick((t) => t + 1)}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <input
        type="text"
        className="rs-files-search"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="rs-tree">
        {matches
          ? matches.slice(0, 200).map((f) => fileRow(f, 0))
          : (() => {
              const root = buildTree(tree.files);
              return (
                <>
                  {[...root.dirs.values()].map((d) => renderDir(d, 0))}
                  {root.files.map((f) => fileRow(f, 0))}
                </>
              );
            })()}
        {matches && matches.length === 0 && <p className="rs-hint">No matches.</p>}
      </div>
    </div>
  );
}

/** Module-level, not a ref: the surface unmounts when the user leaves it, and
 *  a remount must not replay an already-honored browse request. */
let handledBrowseTick = 0;

function BrowserSurface({ browseTo }: { browseTo?: BrowseRequest | null }) {
  const [value, setValue] = useState("");
  const [src, setSrc] = useState<string | null>(null);
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(0); // Chromium zoom level: factor = 1.2^level
  const [device, setDevice] = useState(false);

  const viewRef = useRef<WebviewEl | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Iframe fallback can't see cross-origin history, so back/forward there
  // covers only navigations made from our own chrome (URL bar, server list).
  const histRef = useRef<{ stack: string[]; i: number }>({ stack: [], i: -1 });

  // Scan for listening ports whenever the surface returns to its empty state,
  // so the list is fresh after navigating away and back.
  useEffect(() => {
    if (src !== null) return;
    let cancelled = false;
    apiGet<LocalServer[]>("/api/local-servers")
      .then((list) => !cancelled && setServers(list))
      .catch(() => !cancelled && setServers([]));
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Honor an external browse request (e.g. Team's "open PR here") exactly
  // once, keyed by tick — a surface remount must not replay it.
  useEffect(() => {
    if (browseTo && browseTo.tick !== handledBrowseTick) {
      handledBrowseTick = browseTo.tick;
      open(browseTo.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseTo?.tick]);

  const open = (url: string) => {
    const hist = histRef.current;
    if (hist.stack[hist.i] !== url) {
      hist.stack = [...hist.stack.slice(0, hist.i + 1), url];
      hist.i = hist.stack.length - 1;
    }
    if (!browserApi) {
      setCanBack(hist.i > 0);
      setCanForward(false);
    }
    setSrc(url);
    setValue(url);
    // Re-navigating to a URL React already rendered as `src` needs the
    // imperative poke — the attribute value hasn't changed.
    if (viewRef.current) viewRef.current.src = url;
    if (frameRef.current) frameRef.current.src = url;
  };

  const go = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    open(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  };

  // Attach navigation listeners as the webview mounts; they die with it.
  const attachWebview = (el: WebviewEl | null) => {
    viewRef.current = el;
    if (!el) return;
    const sync = () => {
      setValue(el.getURL());
      setCanBack(el.canGoBack());
      setCanForward(el.canGoForward());
    };
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
  };

  const seek = (delta: -1 | 1) => {
    if (viewRef.current) {
      delta < 0 ? viewRef.current.goBack() : viewRef.current.goForward();
      return;
    }
    const hist = histRef.current;
    const next = hist.i + delta;
    const url = hist.stack[next];
    if (url === undefined) return;
    hist.i = next;
    setCanBack(next > 0);
    setCanForward(next < hist.stack.length - 1);
    setSrc(url);
    setValue(url);
    if (frameRef.current) frameRef.current.src = url;
  };

  const reload = (hard = false) => {
    if (viewRef.current) {
      hard ? viewRef.current.reloadIgnoringCache() : viewRef.current.reload();
    } else if (frameRef.current) {
      frameRef.current.src = frameRef.current.src;
    }
  };

  const applyZoom = (level: number) => {
    const clamped = Math.min(Math.max(level, -5), 5);
    setZoom(clamped);
    viewRef.current?.setZoomLevel(clamped);
  };

  const zoomPercent = Math.round(100 * 1.2 ** zoom);

  const clearAndReload = (clear: () => Promise<void>) => {
    void clear().then(() => reload(true));
  };

  const menuItem = (
    label: string,
    action: () => void,
    opts: { needsElectron?: boolean } = {},
  ) => {
    const blocked = opts.needsElectron && !browserApi;
    return (
      <button
        type="button"
        className="rs-menu-item"
        disabled={blocked || src === null}
        title={blocked ? "Requires the desktop app" : undefined}
        onClick={() => {
          setMenuOpen(false);
          action();
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="rs-browser">
      <div className="rs-browser-bar">
        <button
          type="button"
          className="icon-btn"
          title="Back"
          disabled={!canBack}
          onClick={() => seek(-1)}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Forward"
          disabled={!canForward}
          onClick={() => seek(1)}
        >
          <Icon name="chevron-right" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Reload"
          disabled={src === null}
          onClick={() => reload()}
        >
          <Icon name="refresh" size={14} />
        </button>
        <form
          className="rs-url"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            type="text"
            placeholder="localhost:3000 or https://…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go();
              }
            }}
            spellCheck={false}
          />
        </form>
        <button
          type="button"
          className="icon-btn"
          title="Browser menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name="dots-vertical" size={16} />
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="rs-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="rs-browser-menu" role="menu">
            {menuItem("Hard reload", () => reload(true), { needsElectron: true })}
            {menuItem("Open DevTools", () => viewRef.current?.openDevTools(), {
              needsElectron: true,
            })}
            {menuItem(`${device ? "Hide" : "Show"} device toolbar`, () => setDevice((d) => !d))}
            <div className="rs-menu-zoom">
              <span>Zoom</span>
              <button
                type="button"
                className="icon-btn"
                title="Zoom out"
                disabled={!browserApi}
                onClick={() => applyZoom(zoom - 1)}
              >
                −
              </button>
              <span className="rs-zoom-value">{zoomPercent}%</span>
              <button
                type="button"
                className="icon-btn"
                title="Zoom in"
                disabled={!browserApi}
                onClick={() => applyZoom(zoom + 1)}
              >
                +
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Reset zoom"
                disabled={!browserApi}
                onClick={() => applyZoom(0)}
              >
                ↺
              </button>
            </div>
            {menuItem("Clear cookies", () => clearAndReload(browserApi!.clearCookies), {
              needsElectron: true,
            })}
            {menuItem("Clear cache", () => clearAndReload(browserApi!.clearCache), {
              needsElectron: true,
            })}
          </div>
        </>
      )}

      {src ? (
        <div className={device ? "rs-view rs-view-device" : "rs-view"}>
          {browserApi ? (
            <webview
              ref={(el) => attachWebview(el as WebviewEl | null)}
              src={src}
              partition="persist:rs-browser"
            />
          ) : (
            <iframe ref={frameRef} src={src} title="Browser surface" />
          )}
        </div>
      ) : (
        <div className="rs-servers">
          <div className="rs-servers-label">
            <Icon name="globe" size={14} />
            Local servers
          </div>
          {servers === null ? (
            <p className="rs-hint">Scanning listening ports…</p>
          ) : servers.length === 0 ? (
            <p className="rs-hint">No local servers found. Enter a URL to open it here.</p>
          ) : (
            <>
              <div className="rs-server-list">
                {servers.map((s) => (
                  <button
                    key={s.port}
                    type="button"
                    className="rs-server"
                    onClick={() => open(`http://localhost:${s.port}`)}
                  >
                    <span className="rs-server-name">
                      <strong>{s.command}</strong>
                      <span>localhost:{s.port}</span>
                    </span>
                    <span className="rs-server-dot" aria-hidden />
                  </button>
                ))}
              </div>
              <p className="rs-hint">Select a listening port to open it in this panel.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- Diff -- */

type RepoDiff = { branch: string; files: { status: string; path: string }[]; patch: string };

type DiffFileSection = { path: string; lines: string[] };

/** Split a unified diff into per-file sections, dropping git's header noise. */
function parsePatch(patch: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  for (const chunk of patch.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    // First line: `a/old b/new` — the b-side is the current name.
    const path = /b\/(.*)$/.exec(lines[0] ?? "")?.[1] ?? lines[0] ?? "";
    sections.push({
      path,
      lines: lines.slice(1).filter((l) => /^[+\-@ \\]/.test(l) && !/^(\+\+\+|---) /.test(l)),
    });
  }
  return sections;
}

function diffLineClass(line: string): string {
  if (line.startsWith("@")) return "rs-diff-line rs-diff-hunk";
  if (line.startsWith("+")) return "rs-diff-line rs-diff-add";
  if (line.startsWith("-")) return "rs-diff-line rs-diff-del";
  return "rs-diff-line";
}

function DiffSurface({ projectId }: { projectId: number | null }) {
  const [diff, setDiff] = useState<RepoDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    setError(null);
    apiGet<RepoDiff>(`/api/projects/${projectId}/diff`)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick]);

  if (projectId === null) return <p className="rs-hint">Open a project to review its changes.</p>;
  if (error) return <p className="rs-hint">{error}</p>;
  if (!diff) return <p className="rs-hint">Reading the working tree…</p>;

  const sections = parsePatch(diff.patch);
  const untracked = diff.files.filter((f) => f.status === "??");

  return (
    <div className="rs-files">
      <div className="rs-files-head">
        <span className="rs-files-title">{diff.branch}</span>
        <span className="rs-files-count">
          {diff.files.length} {diff.files.length === 1 ? "change" : "changes"}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Refresh"
          onClick={() => setRefreshTick((t) => t + 1)}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {diff.files.length === 0 ? (
        <p className="rs-hint">Working tree clean — nothing to review.</p>
      ) : (
        <div className="rs-diff">
          {sections.map((s) => {
            const isCollapsed = collapsed.has(s.path);
            const status = diff.files.find((f) => f.path === s.path)?.status ?? "M";
            return (
              <div key={s.path} className="rs-diff-file">
                <button
                  type="button"
                  className="rs-tree-row rs-diff-filehead"
                  title={s.path}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      isCollapsed ? next.delete(s.path) : next.add(s.path);
                      return next;
                    })
                  }
                >
                  <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={13} />
                  <span className="rs-tree-name">{s.path}</span>
                  <span className={`rs-diff-status rs-diff-status-${status[0]?.toLowerCase()}`}>
                    {status}
                  </span>
                </button>
                {!isCollapsed && (
                  <pre className="rs-diff-body">
                    {s.lines.map((line, i) => (
                      <span key={i} className={diffLineClass(line)}>
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                )}
              </div>
            );
          })}
          {untracked.length > 0 && (
            <div className="rs-diff-file">
              <div className="rs-tree-row rs-diff-filehead rs-diff-untracked-head">
                <span className="rs-tree-name">Untracked</span>
              </div>
              {untracked.map((f) => (
                <div key={f.path} className="rs-diff-untracked" title={f.path}>
                  <FileBadge name={f.path.split("/").pop()!} />
                  <span className="rs-tree-name">{f.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The right panel (⌘L): opens to a surface picker; each surface fills the
 * panel until the back button returns to the picker. Files and Diff need an
 * open project — their content is the project's checkout.
 */
export function RightSidebar({
  open,
  projectId,
  browseTo,
}: {
  open: boolean;
  projectId: number | null;
  /** When set (and on each new tick), the panel jumps to the Browser surface. */
  browseTo?: BrowseRequest | null;
}) {
  const [surface, setSurface] = useState<Surface | null>(null);
  const [width, setWidth] = useState(400);
  const current = SURFACES.find((s) => s.key === surface);

  useEffect(() => {
    if (browseTo) setSurface("browser");
  }, [browseTo?.tick]);

  // Drag the left edge to resize; pointer capture keeps the drag alive when
  // the cursor outruns the 4px handle.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setWidth(Math.min(Math.max(next, 280), window.innerWidth * 0.7));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <aside
      className={open ? "right-sidebar open" : "right-sidebar"}
      aria-hidden={!open}
      style={open ? { width } : undefined}
    >
      <div className="rs-resize" onPointerDown={startResize} />

      {current ? (
        <div className="rs-surface">
          <div className="rs-header">
            <button
              type="button"
              className="icon-btn"
              title="Back to surfaces"
              onClick={() => setSurface(null)}
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <span className="rs-title">{current.title}</span>
          </div>
          {current.key === "terminal" && (
            <div className="rs-term">
              <TermPane open={open} active onFocus={() => {}} />
            </div>
          )}
          {current.key === "browser" && <BrowserSurface browseTo={browseTo} />}
          {current.key === "files" && <FilesSurface projectId={projectId} />}
          {current.key === "diff" && <DiffSurface projectId={projectId} />}
        </div>
      ) : (
        <div className="rs-empty">
          <h2>Open a surface</h2>
          <p>Choose what to show in the right panel.</p>
          <div className="rs-grid">
            {SURFACES.map((s) => (
              <button
                key={s.key}
                type="button"
                className="rs-card"
                disabled={
                  s.disabled ||
                  ((s.key === "files" || s.key === "diff") && projectId === null)
                }
                title={
                  (s.key === "files" || s.key === "diff") && projectId === null
                    ? "Open a project first"
                    : undefined
                }
                onClick={() => setSurface(s.key)}
              >
                <Icon name={s.icon} size={18} />
                <strong>{s.title}</strong>
                <span>{s.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

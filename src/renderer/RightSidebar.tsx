import { useState } from "react";
import { Icon, type IconName } from "./icons";
import { TermPane } from "./TerminalDrawer.tsx";

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
    disabled: true,
  },
  {
    key: "diff",
    icon: "review",
    title: "Diff",
    desc: "Review changes in this thread.",
    disabled: true,
  },
];

function BrowserSurface() {
  const [value, setValue] = useState("");
  const [src, setSrc] = useState<string | null>(null);

  const go = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    setSrc(url);
    setValue(url);
  };

  return (
    <div className="rs-browser">
      <form
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
          spellCheck={false}
        />
      </form>
      {src ? (
        <iframe src={src} title="Browser surface" />
      ) : (
        <p className="rs-hint">Enter a URL to open it here.</p>
      )}
    </div>
  );
}

/**
 * The right panel (⌘L): opens to a surface picker; each surface fills the
 * panel until the back button returns to the picker. Files and Diff are
 * placeholders until they have server support.
 */
export function RightSidebar({ open }: { open: boolean }) {
  const [surface, setSurface] = useState<Surface | null>(null);
  const current = SURFACES.find((s) => s.key === surface);

  return (
    <aside className={open ? "right-sidebar open" : "right-sidebar"} aria-hidden={!open}>
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
          {current.key === "browser" && <BrowserSurface />}
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
                disabled={s.disabled}
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

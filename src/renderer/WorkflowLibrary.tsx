import { useEffect, useRef, useState } from "react";
import type { WorkflowListing } from "../server/types.ts";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errorMessage } from "./api.ts";
import { AVATAR_COLORS, avatarColor } from "./Home.tsx";
import { timeAgo } from "./format.ts";
import { Icon, isIconName, type IconName } from "./icons.tsx";
import {
  clampWfVisible,
  filterWorkflows,
  loadWorkflowPrefs,
  saveWorkflowPrefs,
  sortWorkflows,
  WF_SORTS,
  type WorkflowPrefs,
  type WorkflowSort,
} from "./workflowPrefs.ts";

/** The icons a workflow avatar can wear; everything else in the catalog is UI chrome. */
const AVATAR_ICONS: IconName[] = ["sparkle", "bolt", "globe", "book", "folder", "code", "play", "pencil"];

const SORT_LABELS: Record<WorkflowSort, string> = {
  name: "Name",
  created: "Created at",
  usage: "Most used",
};

/**
 * The app-global Workflow library, hosted as a view within Home (ticket 44),
 * with Home's list ergonomics (ticket 51): search, sort, visible cap, and
 * archived rows hidden until asked for. Identity ops only — content is
 * immutable versions; creation is a full page (WorkflowCreate), and delete
 * exists solely for never-used rows. Every action refetches: default and
 * archive move flags across rows, so the server's listing is the only
 * honest render source.
 */
export function WorkflowLibrary({
  onCreateNew,
  onOpenEditor,
}: {
  onCreateNew: () => void;
  /** Opens the canvas editor (ticket 48) on this row's workflow. */
  onOpenEditor: (row: WorkflowListing) => void;
}) {
  const [rows, setRows] = useState<WorkflowListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The one workflow whose archive needs a successor named (it's the default).
  const [leaving, setLeaving] = useState<WorkflowListing | null>(null);
  // Rename lives up here so a fresh creation can land already-renaming.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  // Same fixed-position anchor dance as Home's row menu: the list scrolls,
  // so the open state carries the trigger's viewport anchor with the row id.
  const [menuFor, setMenuFor] = useState<{ id: number; top: number; right: number } | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs] = useState<WorkflowPrefs>(loadWorkflowPrefs);
  const updatePrefs = (patch: Partial<WorkflowPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveWorkflowPrefs(next);
      return next;
    });
  };

  const load = () =>
    apiGet<WorkflowListing[]>("/api/workflows")
      .then((listed) => {
        setRows(listed);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  // Menus close the way native ones do: any click elsewhere, Escape, or a
  // scroll (the row menu is viewport-anchored and would drift).
  useEffect(() => {
    if (menuFor === null && !sortOpen) return;
    const close = () => {
      setMenuFor(null);
      setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuFor, sortOpen]);

  // "/" jumps to search from anywhere in the library, same rule as Home.
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onSlash);
    return () => document.removeEventListener("keydown", onSlash);
  }, []);

  const act = async (call: () => Promise<unknown>) => {
    try {
      await call();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Import a shared workflow JSON (the editor's Share download): create the
  // identity, land the graph as a draft, and publish if it validates —
  // otherwise it arrives as a draft to fix in the editor.
  const importWorkflow = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const shared = parsed as {
        tracker?: string;
        name?: string;
        description?: string;
        color?: string | null;
        icon?: string | null;
        graph?: unknown;
      };
      if (shared?.tracker !== "workflow" || typeof shared.name !== "string" || !shared.graph) {
        throw new Error(`${file.name} is not a Tracker workflow export`);
      }
      const created = await apiPost<WorkflowListing>("/api/workflows", {
        name: shared.name,
        description: shared.description ?? "",
        color: shared.color ?? null,
        icon: shared.icon ?? null,
      });
      await apiPut(`/api/workflows/${created.id}/draft`, shared.graph);
      try {
        await apiPost(`/api/workflows/${created.id}/draft/publish`, {});
      } catch {
        // Violations keep it a draft; the editor shows why on open.
      }
      await load();
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toggleArchived = (row: WorkflowListing) => {
    if (row.archived) return void act(() => apiPost(`/api/workflows/${row.id}/unarchive`, {}));
    // Archiving the default demands a successor in the same call (ticket 43):
    // route through the dialog instead of letting the server 409.
    if (row.isDefault) return setLeaving(row);
    void act(() => apiPost(`/api/workflows/${row.id}/archive`, {}));
  };

  const filtered = sortWorkflows(filterWorkflows(rows ?? [], query, prefs), prefs.sort);
  // The visible cap applies only to the idle list — a search always sweeps
  // everything, so no workflow is ever unreachable.
  const capped = query === "" ? filtered.slice(0, prefs.visible) : filtered;
  const hiddenCount = filtered.length - capped.length;

  return (
    <div className="home wf-library">
      <h1 className="wordmark">tracker</h1>
      <div className="home-picker wf-picker">
        <div className="home-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            ref={searchRef}
            placeholder="Search workflows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>/</kbd>
        </div>
        <div className="home-header">
          <span className="home-title">Workflows</span>
          <span className="home-header-actions">
            <button
              type="button"
              className="icon-btn"
              title="Sort and filter"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={(e) => {
                // The document-level closer sees this click too; stop it so
                // the toggle isn't immediately undone.
                e.stopPropagation();
                setSortOpen((open) => !open);
              }}
            >
              <Icon name="arrows-sort" size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Import workflow JSON"
              onClick={() => importRef.current?.click()}
            >
              <Icon name="import" size={16} />
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importWorkflow(file);
              }}
            />
            <button type="button" className="icon-btn" title="New workflow" onClick={onCreateNew}>
              <Icon name="grid-plus" size={16} />
            </button>
            {sortOpen && (
              <div
                className="row-menu sort-menu"
                role="menu"
                // Clicks inside adjust preferences; only outside clicks close.
                onClick={(e) => e.stopPropagation()}
              >
                <span className="menu-label">Sort workflows</span>
                {WF_SORTS.map((sort) => (
                  <button
                    key={sort}
                    type="button"
                    role="menuitemradio"
                    aria-checked={prefs.sort === sort}
                    className="menu-item"
                    onClick={() => updatePrefs({ sort })}
                  >
                    <span className="menu-tick">
                      {prefs.sort === sort && <Icon name="check" size={14} />}
                    </span>
                    {SORT_LABELS[sort]}
                  </button>
                ))}
                <span className="menu-label">Visible workflows</span>
                <div className="menu-stepper">
                  <button
                    type="button"
                    aria-label="Show fewer workflows"
                    onClick={() => updatePrefs({ visible: clampWfVisible(prefs.visible - 1) })}
                  >
                    −
                  </button>
                  <span>{prefs.visible}</span>
                  <button
                    type="button"
                    aria-label="Show more workflows"
                    onClick={() => updatePrefs({ visible: clampWfVisible(prefs.visible + 1) })}
                  >
                    +
                  </button>
                </div>
                <hr className="menu-divider" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={prefs.showArchived}
                  className="menu-item"
                  onClick={() => updatePrefs({ showArchived: !prefs.showArchived })}
                >
                  <span className="menu-tick">
                    {prefs.showArchived && <Icon name="check" size={14} />}
                  </span>
                  Show archived
                </button>
              </div>
            )}
          </span>
        </div>
        {error && <p className="banner error">{error}</p>}
        <ul className="wf-list">
          {capped.map((row) => (
            <WorkflowRow
              key={row.id}
              row={row}
              renaming={renamingId === row.id}
              onRenameStart={() => {
                setMenuFor(null);
                setRenamingId(row.id);
              }}
              onRenameEnd={(name) => {
                setRenamingId(null);
                if (name !== null) void act(() => apiPatch(`/api/workflows/${row.id}`, { name }));
              }}
              menuAnchor={menuFor?.id === row.id ? menuFor : null}
              onMenuToggle={(anchor) =>
                setMenuFor((open) => (open?.id === row.id || anchor === null ? null : anchor))
              }
              onDuplicate={() => void act(() => apiPost(`/api/workflows/${row.id}/duplicate`, {}))}
              onMakeDefault={() => void act(() => apiPost(`/api/workflows/${row.id}/default`, {}))}
              onDelete={() => void act(() => apiDelete(`/api/workflows/${row.id}`))}
              onToggleArchived={() => toggleArchived(row)}
              onOpen={() => onOpenEditor(row)}
            />
          ))}
          {hiddenCount > 0 && (
            <li className="dim home-empty">
              +{hiddenCount} more — search, or raise visible workflows
            </li>
          )}
          {rows !== null && filtered.length === 0 && rows.length > 0 && query !== "" && (
            <li className="dim home-empty">No workflow matches “{query}”</li>
          )}
          {rows !== null && rows.length === 0 && (
            <li className="dim home-empty">The library is empty — create a workflow</li>
          )}
        </ul>
      </div>
      {leaving && rows && (
        <SuccessorDialog
          leaving={leaving}
          options={rows.filter((row) => !row.archived && row.id !== leaving.id)}
          onCancel={() => setLeaving(null)}
          onConfirm={(successorId) => {
            setLeaving(null);
            void act(() => apiPost(`/api/workflows/${leaving.id}/archive`, { successorId }));
          }}
        />
      )}
    </div>
  );
}

function WorkflowRow({
  row,
  renaming,
  onRenameStart,
  onRenameEnd,
  menuAnchor,
  onMenuToggle,
  onDuplicate,
  onMakeDefault,
  onDelete,
  onToggleArchived,
  onOpen,
}: {
  row: WorkflowListing;
  renaming: boolean;
  onRenameStart: () => void;
  /** null = cancelled or unchanged; a string commits the new name. */
  onRenameEnd: (name: string | null) => void;
  menuAnchor: { top: number; right: number } | null;
  onMenuToggle: (anchor: { id: number; top: number; right: number } | null) => void;
  onDuplicate: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
  onToggleArchived: () => void;
  /** Row click — opens the canvas editor. */
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState(row.name);
  // A rename begun elsewhere (the kebab, or creation) seeds the draft fresh.
  useEffect(() => {
    if (renaming) setDraft(row.name);
  }, [renaming, row.name]);

  const submitRename = () => {
    const name = draft.trim();
    onRenameEnd(name !== "" && name !== row.name ? name : null);
  };

  return (
    // Clicking the row opens the canvas editor (ticket 48); the kebab, its
    // menu, and a live rename input all stop propagation to stay row-local.
    <li
      className={row.archived ? "wf-row archived" : "wf-row"}
      // The subline is gone (one-line rows); description and phases live in
      // the hover tooltip instead.
      title={row.description !== "" ? row.description : row.phases.join(" › ") || undefined}
      onClick={() => {
        if (!renaming) onOpen();
      }}
    >
      <span className="avatar" style={{ background: row.color ?? avatarColor(row.name) }}>
        {row.icon !== null && isIconName(row.icon) ? (
          <Icon name={row.icon} size={14} />
        ) : (
          row.name.slice(0, 1).toUpperCase()
        )}
      </span>
      <div className="wf-main">
        <div className="wf-titleline">
          {!renaming ? (
            <span className="wf-name">{row.name}</span>
          ) : (
            <input
              autoFocus
              className="wf-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") onRenameEnd(null);
              }}
            />
          )}
          <span className="wf-version dim">v{row.version}</span>
          {row.isDefault && <span className="wf-badge default">Default</span>}
          {row.archived && <span className="wf-badge archived">Archived</span>}
          {row.hasDraft && <span className="wf-badge draft">Draft</span>}
        </div>
      </div>
      <span className="wf-time">
        {/* A zero count is just noise — only a real adoption earns a mention. */}
        {row.usedByProjects > 0 &&
          `${row.usedByProjects} ${row.usedByProjects === 1 ? "project" : "projects"} · `}
        {timeAgo(row.createdAt)}
      </span>
      <div className="wf-actions">
        <button
          type="button"
          className="icon-btn row-kebab"
          title="More options"
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          onClick={(e) => {
            // The document-level closer sees this click too; stop it so the
            // toggle isn't immediately undone.
            e.stopPropagation();
            const anchor = e.currentTarget.getBoundingClientRect();
            onMenuToggle({
              id: row.id,
              top: anchor.bottom + 2,
              right: window.innerWidth - anchor.right,
            });
          }}
        >
          <Icon name="dots-horizontal" size={16} />
        </button>
      </div>
      {/* Outside .wf-actions on purpose: a transformed ancestor would turn
          position:fixed into ancestor-relative and strand the menu. */}
      {menuAnchor !== null && (
        <div
          className="row-menu"
          role="menu"
          style={{ position: "fixed", top: menuAnchor.top, right: menuAnchor.right }}
          // Menu actions are row-local: without this, a menu click would
          // bubble to the row and open the editor it sits on. Stopping it
          // also skips the document-level closer, so close explicitly.
          onClick={(e) => {
            e.stopPropagation();
            onMenuToggle(null);
          }}
        >
          <button type="button" role="menuitem" onClick={onRenameStart}>
            Rename
          </button>
          <button type="button" role="menuitem" onClick={onDuplicate}>
            Duplicate
          </button>
          {!row.isDefault && !row.archived && (
            <button type="button" role="menuitem" onClick={onMakeDefault}>
              Make default
            </button>
          )}
          <button type="button" role="menuitem" onClick={onToggleArchived}>
            {row.archived ? "Unarchive" : "Archive"}
          </button>
          {row.deletable && (
            <button type="button" role="menuitem" className="danger" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Shared icon + color chooser: "Auto" keeps the stored value null (the row
 * derives a hash color and a letter glyph from the name), a pick stores it.
 */
function AppearancePicker({
  name,
  color,
  icon,
  onColor,
  onIcon,
}: {
  /** Current (possibly draft) workflow name — drives the Auto preview. */
  name: string;
  color: string | null;
  icon: IconName | null;
  onColor: (color: string | null) => void;
  onIcon: (icon: IconName | null) => void;
}) {
  const shownColor = color ?? avatarColor(name);
  const letter = (name.trim() || "N").slice(0, 1).toUpperCase();
  return (
    <div className="wf-appearance">
      <div className="wf-field">
        <span className="wf-field-label">Color</span>
        <div className="wf-swatches" role="radiogroup" aria-label="Avatar color">
          <button
            type="button"
            role="radio"
            aria-checked={color === null}
            className={color === null ? "wf-swatch auto selected" : "wf-swatch auto"}
            title="Auto (from name)"
            onClick={() => onColor(null)}
          >
            A
          </button>
          {AVATAR_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={color === option}
              className={color === option ? "wf-swatch selected" : "wf-swatch"}
              style={{ background: option }}
              title={option}
              onClick={() => onColor(option)}
            />
          ))}
        </div>
      </div>
      <div className="wf-field">
        <span className="wf-field-label">Icon</span>
        <div className="wf-swatches" role="radiogroup" aria-label="Avatar icon">
          <button
            type="button"
            role="radio"
            aria-checked={icon === null}
            className={icon === null ? "wf-swatch glyph selected" : "wf-swatch glyph"}
            style={{ background: shownColor }}
            title="Auto (first letter)"
            onClick={() => onIcon(null)}
          >
            {letter}
          </button>
          {AVATAR_ICONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={icon === option}
              className={icon === option ? "wf-swatch glyph selected" : "wf-swatch glyph"}
              style={{ background: shownColor }}
              title={option}
              onClick={() => onIcon(option)}
            >
              <Icon name={option} size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The pick-a-successor flow, one dialog (ticket 44): archiving the Default
 * Workflow and crowning its successor happen in the same action; cancel
 * leaves both untouched.
 */
function SuccessorDialog({
  leaving,
  options,
  onCancel,
  onConfirm,
}: {
  leaving: WorkflowListing;
  options: WorkflowListing[];
  onCancel: () => void;
  onConfirm: (successorId: number) => void;
}) {
  const [successorId, setSuccessorId] = useState<number | null>(options[0]?.id ?? null);

  return (
    <div className="wf-overlay" onClick={onCancel}>
      <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Archive “{leaving.name}”?</h3>
        <p className="dim">
          It is the Default Workflow — name a successor to take the designation in the same step.
          Projects already on “{leaving.name}” keep running it.
        </p>
        {options.length === 0 ? (
          <p className="banner error">
            No other active workflow can take over — unarchive or duplicate one first.
          </p>
        ) : (
          <ul className="wf-successors">
            {options.map((option) => (
              <li key={option.id}>
                <label>
                  <input
                    type="radio"
                    name="successor"
                    checked={successorId === option.id}
                    onChange={() => setSuccessorId(option.id)}
                  />
                  {option.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="formrow">
          <button
            type="button"
            disabled={successorId === null}
            onClick={() => successorId !== null && onConfirm(successorId)}
          >
            Archive and hand over
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The full-page create form (ticket 51): a brand-new workflow starts with a
 * name and description; the version is always v1 (a trigger-only graph the
 * editor fills). Create lands back in the library; so does Cancel.
 */
export function WorkflowCreate({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<IconName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (name.trim() === "") {
      setError("A workflow needs a name");
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/workflows", { name, description, color, icon });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="home wf-library">
      <h1 className="wordmark">tracker</h1>
      <div className="home-picker wf-picker">
        <div className="home-header">
          <button type="button" className="wf-back" title="Back to workflows" onClick={onDone}>
            <Icon name="chevron-left" size={16} />
            Back
          </button>
        </div>
        {error && <p className="banner error">{error}</p>}
        <form
          className="wf-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="wf-field">
            <span className="wf-field-label">Name</span>
            <input
              autoFocus
              value={name}
              placeholder="e.g. RPIRD (Aflac KB)"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="wf-field">
            <span className="wf-field-label">Description</span>
            <textarea
              rows={3}
              value={description}
              placeholder="What this workflow is for — shown in the library list"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <AppearancePicker name={name} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
          <div className="formrow">
            <button type="submit" disabled={busy || name.trim() === ""}>
              Create workflow
            </button>
            <button type="button" onClick={onDone}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

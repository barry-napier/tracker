import { useEffect, useState } from "react";
import type { WorkflowListing } from "../server/types.ts";
import { apiGet, apiPatch, apiPost, errorMessage } from "./api.ts";

/**
 * The app-global Workflow library, hosted as a view within Home (ticket 44).
 * Identity ops only — duplicate, rename, archive/unarchive, set default;
 * content is immutable versions and creation is duplicate-only until the
 * editor ticket. Every action refetches: default and archive move flags
 * across rows, so the server's listing is the only honest render source.
 */
export function WorkflowLibrary() {
  const [rows, setRows] = useState<WorkflowListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The one workflow whose archive needs a successor named (it's the default).
  const [leaving, setLeaving] = useState<WorkflowListing | null>(null);

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

  const act = async (call: () => Promise<unknown>) => {
    try {
      await call();
      await load();
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

  return (
    <div className="home wf-library">
      <h1 className="wordmark">tracker</h1>
      <div className="home-picker wf-picker">
        <div className="home-header">
          <span className="home-title">Workflows</span>
        </div>
        {error && <p className="banner error">{error}</p>}
        <ul className="wf-list">
          {rows?.map((row) => (
            <WorkflowRow
              key={row.id}
              row={row}
              onDuplicate={() => void act(() => apiPost(`/api/workflows/${row.id}/duplicate`, {}))}
              onRename={(name) => void act(() => apiPatch(`/api/workflows/${row.id}`, { name }))}
              onMakeDefault={() => void act(() => apiPost(`/api/workflows/${row.id}/default`, {}))}
              onToggleArchived={() => toggleArchived(row)}
            />
          ))}
          {rows !== null && rows.length === 0 && (
            <li className="dim home-empty">The library is empty</li>
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
  onDuplicate,
  onRename,
  onMakeDefault,
  onToggleArchived,
}: {
  row: WorkflowListing;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onMakeDefault: () => void;
  onToggleArchived: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const submitRename = () => {
    const name = (draft ?? "").trim();
    setDraft(null);
    if (name !== "" && name !== row.name) onRename(name);
  };

  return (
    <li className={row.archived ? "wf-row archived" : "wf-row"}>
      <div className="wf-main">
        <div className="wf-titleline">
          {draft === null ? (
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
                if (e.key === "Escape") setDraft(null);
              }}
            />
          )}
          <span className="wf-version dim">v{row.version}</span>
          {row.isDefault && <span className="wf-badge default">Default</span>}
          {row.archived && <span className="wf-badge archived">Archived</span>}
          {row.hasDraft && <span className="wf-badge draft">Unpublished changes</span>}
        </div>
        <div className="wf-sub">
          <span className="wf-phases">{row.phases.join(" › ")}</span>
          <span className="wf-used">
            {row.usedByProjects === 1 ? "1 project" : `${row.usedByProjects} projects`}
          </span>
        </div>
      </div>
      <div className="wf-actions">
        {draft === null && (
          <button type="button" className="wf-action" onClick={() => setDraft(row.name)}>
            Rename
          </button>
        )}
        <button type="button" className="wf-action" onClick={onDuplicate}>
          Duplicate
        </button>
        {!row.isDefault && !row.archived && (
          <button type="button" className="wf-action" onClick={onMakeDefault}>
            Make default
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={!row.archived}
          className={row.archived ? "wf-toggle off" : "wf-toggle on"}
          title={row.archived ? "Unarchive — restore to selection" : "Archive — remove from selection"}
          onClick={onToggleArchived}
        >
          <span className="wf-knob" />
        </button>
      </div>
    </li>
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

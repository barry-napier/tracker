import { useEffect, useState } from "react";
import type { Project, WorkflowListing } from "../server/types.ts";
import { apiGet, apiPatch, errorMessage } from "./api.ts";

/**
 * The shared workflow picker (ticket 45) for any surface that assigns a
 * Project's workflow: active workflows only, the current (or default)
 * selection preselected. A project sitting on an archived workflow still
 * sees that selection, labeled — the picker just won't offer archived
 * options as new choices.
 */
export function WorkflowPicker({
  workflows,
  value,
  onChange,
}: {
  workflows: WorkflowListing[];
  /** The current selection; null = "none yet" → the Default preselects. */
  value: number | null;
  onChange: (workflowId: number) => void;
}) {
  const current = workflows.find((w) => w.id === value);
  const selectable = workflows.filter((w) => !w.archived);
  // An archived current selection stays visible — as the selection, labeled,
  // never as an offer.
  const options = current?.archived ? [current, ...selectable] : selectable;
  const selectedId = value ?? workflows.find((w) => w.isDefault)?.id ?? null;

  return (
    <ul className="wf-successors wf-options">
      {options.map((option) => (
        <li key={option.id}>
          <label>
            <input
              type="radio"
              name="workflow-pick"
              checked={selectedId === option.id}
              onChange={() => !option.archived && onChange(option.id)}
            />
            <span className="wf-option-main">
              <span className="wf-option-title">
                {option.name}
                {option.isDefault && <span className="wf-badge default">Default</span>}
                {option.archived && <span className="wf-badge archived">Archived</span>}
              </span>
              <span className="wf-option-phases dim">{option.phases.join(" › ")}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * Project settings behind the topbar gear (ticket 45): first section is the
 * workflow selection. Changes apply immediately but act forward — the next
 * claim pins the new head version; a running Run finishes on its own pin.
 */
export function ProjectSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowListing[] | null>(null);
  // Live row, not the tab's cached one — the selection may have changed since
  // the tab was hydrated, and correctness of the archived-selection labeling
  // depends on the real current value.
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      apiGet<WorkflowListing[]>("/api/workflows"),
      apiGet<Project>(`/api/projects/${project.id}`),
    ])
      .then(([listed, live]) => {
        setWorkflows(listed);
        setWorkflowId(live.workflowId);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [project.id]);

  const pick = async (picked: number) => {
    const previous = workflowId;
    setWorkflowId(picked);
    try {
      await apiPatch(`/api/projects/${project.id}`, { workflowId: picked });
      setError(null);
    } catch (e) {
      setWorkflowId(previous);
      setError(errorMessage(e));
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{project.name} settings</h3>
        <section>
          <h4 className="wf-section-title">Workflow</h4>
          <p className="dim">
            Every ticket on this board runs the selected workflow. A change takes effect at the
            next claim — running attempts finish on the version they pinned.
          </p>
          {error && <p className="banner error">{error}</p>}
          {workflows && workflowId !== null && (
            <WorkflowPicker workflows={workflows} value={workflowId} onChange={(id) => void pick(id)} />
          )}
        </section>
        <div className="formrow">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

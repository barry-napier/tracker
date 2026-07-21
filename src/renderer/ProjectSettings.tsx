import { useEffect, useState } from "react";
import type { Project, ProviderConfig, WorkflowListing } from "../server/types.ts";
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

/** `KEY=value` lines ⇄ the env object the API stores. */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function envFromText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/**
 * App-level provider config (ticket 38), hosted in the Project settings
 * dialog because it is the only settings surface the app has — hence the
 * "every project on this machine" wording, which is doing real work: this is
 * the one section here whose scope is not the Project. Saves on blur; the
 * adapter re-reads config per phase, so the next claim picks it up.
 */
function ProviderConfigSection() {
  const [configs, setConfigs] = useState<ProviderConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<ProviderConfig[]>("/api/provider-config")
      .then(setConfigs)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const save = async (provider: string, patch: Record<string, unknown>) => {
    try {
      const saved = await apiPatch<ProviderConfig>(`/api/provider-config/${provider}`, patch);
      setConfigs((current) =>
        (current ?? []).map((c) => (c.provider === saved.provider ? saved : c)),
      );
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <section>
      <h4 className="wf-section-title">Providers</h4>
      <p className="dim">
        Applies to every project on this machine. Blank means the provider's own default — the
        binary is resolved on <code>PATH</code>. A change takes effect at the next claim.
      </p>
      {error && <p className="banner error">{error}</p>}
      {configs?.map((config) => (
        <details key={config.provider} className="provider-config">
          <summary>
            {config.provider}
            {config.model && <span className="dim"> — {config.model}</span>}
          </summary>
          <label>
            Binary path
            <input
              type="text"
              defaultValue={config.binaryPath ?? ""}
              placeholder={`resolve "${config.provider === "claude-code" ? "claude" : config.provider}" on PATH`}
              onBlur={(e) => void save(config.provider, { binaryPath: e.target.value })}
            />
          </label>
          <label>
            Pinned model
            <input
              type="text"
              defaultValue={config.model ?? ""}
              placeholder="provider default"
              onBlur={(e) => void save(config.provider, { model: e.target.value })}
            />
          </label>
          <label>
            Budget cap per phase (USD)
            <input
              type="number"
              min="0"
              step="0.5"
              defaultValue={config.maxBudgetUsd ?? ""}
              placeholder="uncapped"
              onBlur={(e) =>
                void save(config.provider, {
                  maxBudgetUsd: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Extra environment
            <textarea
              rows={3}
              defaultValue={envToText(config.env)}
              placeholder="KEY=value, one per line"
              onBlur={(e) => void save(config.provider, { env: envFromText(e.target.value) })}
            />
          </label>
        </details>
      ))}
    </section>
  );
}

/**
 * Project settings behind the topbar gear (ticket 45): first section is the
 * workflow selection. Changes apply immediately but act forward — the next
 * claim pins the new head version; a running Run finishes on its own pin.
 */
export function ProjectSettings({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  /** The server-updated row after a successful pick — for tab-cache refresh. */
  onSaved?: (row: Project) => void;
}) {
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
      const row = await apiPatch<Project>(`/api/projects/${project.id}`, { workflowId: picked });
      onSaved?.(row);
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
        <ProviderConfigSection />
        <div className="formrow">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

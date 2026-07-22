import { useEffect, useState } from "react";
import type { Project, ProviderInstance, ProviderName, WorkflowListing } from "../server/types.ts";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "./api.ts";
import { PROVIDER_LABELS } from "./format.ts";
import { Icon } from "./icons.tsx";
import {
  DRIVER_CATALOG,
  PROVIDER_LOGOS,
  refreshProviderInstances,
  useProviderInstances,
} from "./providers.ts";

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
 * The provider list (migration 26), hosted in the app Settings surface. The
 * list starts empty: providers are added deliberately from the driver
 * catalog, then configured in place. Instances are user-addable entries over
 * the fixed adapter set; field saves land on blur, and the adapter re-reads
 * config per phase, so the next claim picks a change up. Deleting a
 * referenced instance is server-refused — the enabled switch is the "stop
 * using it, keep history resolvable" path, and both surface here.
 */
export function ProviderConfigSection() {
  const instances = useProviderInstances();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = () => refreshProviderInstances().catch((e) => setError(errorMessage(e)));

  const save = async (id: string, patch: Record<string, unknown>) => {
    try {
      await apiPatch(`/api/provider-instances/${id}`, patch);
      setError(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const add = async (driver: ProviderName, displayName: string) => {
    try {
      const created = await apiPost<ProviderInstance>("/api/provider-instances", {
        driver,
        displayName,
      });
      setError(null);
      setAdding(false);
      // Land the user straight in the new card's config.
      setExpandedId(created.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await apiDelete(`/api/provider-instances/${id}`);
      setError(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <section>
      <h4 className="wf-section-title">Providers</h4>
      <p className="dim">
        The coding agents this machine can run, shared by every project. Blank config means the
        provider's own default — the binary resolves on <code>PATH</code>. Changes take effect at
        the next claim.
      </p>
      {error && <p className="banner error">{error}</p>}
      {instances !== null && instances.length === 0 && !adding && (
        <div className="provider-empty">
          <p>No providers yet.</p>
          <p className="dim">Add one to promote tickets and run agent phases.</p>
        </div>
      )}
      <ul className="provider-list">
        {instances?.map((instance) => {
          const expanded = expandedId === instance.id;
          return (
            <li key={instance.id} className={expanded ? "provider-row expanded" : "provider-row"}>
              <div className="provider-row-head">
                <button
                  type="button"
                  className="provider-row-main"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : instance.id)}
                >
                  <img
                    className={instance.enabled ? "provider-logo" : "provider-logo off"}
                    src={PROVIDER_LOGOS[instance.driver]}
                    alt=""
                    width={22}
                    height={22}
                  />
                  <span className="provider-row-titles">
                    <span className="provider-row-name">{instance.displayName}</span>
                    {(() => {
                      // Don't echo the name as its own subtitle: a default
                      // entry named after its driver shows model info only.
                      const driverLabel = PROVIDER_LABELS[instance.driver] ?? instance.driver;
                      const parts = [
                        ...(driverLabel === instance.displayName ? [] : [driverLabel]),
                        ...(instance.model ? [instance.model] : []),
                      ];
                      return parts.length > 0 ? (
                        <span className="provider-row-driver dim">{parts.join(" · ")}</span>
                      ) : null;
                    })()}
                  </span>
                  {!instance.available && (
                    <span className="provider-chip warn" title={instance.availabilityReason ?? ""}>
                      Not installed
                    </span>
                  )}
                  {!instance.enabled && <span className="provider-chip off">Disabled</span>}
                  <Icon name="chevron-down" size={14} />
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={instance.enabled}
                  aria-label={`${instance.displayName} enabled`}
                  className="provider-switch"
                  onClick={() => void save(instance.id, { enabled: !instance.enabled })}
                >
                  <span className="provider-switch-knob" />
                </button>
              </div>
              {expanded && (
                <div className="provider-form">
                  <label>
                    Display name
                    <input
                      type="text"
                      defaultValue={instance.displayName}
                      onBlur={(e) => {
                        // Blanking a name is not a clear-to-default; refuse locally.
                        if (e.target.value.trim() !== "") {
                          void save(instance.id, { displayName: e.target.value });
                        }
                      }}
                    />
                  </label>
                  <label>
                    Binary path
                    <input
                      type="text"
                      defaultValue={instance.binaryPath ?? ""}
                      placeholder={`resolve "${
                        DRIVER_CATALOG.find((d) => d.driver === instance.driver)?.binary ??
                        instance.driver
                      }" on PATH`}
                      onBlur={(e) => void save(instance.id, { binaryPath: e.target.value })}
                    />
                  </label>
                  <label>
                    Pinned model
                    <input
                      type="text"
                      defaultValue={instance.model ?? ""}
                      placeholder="provider default"
                      onBlur={(e) => void save(instance.id, { model: e.target.value })}
                    />
                  </label>
                  <label>
                    Budget cap per phase (USD)
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      defaultValue={instance.maxBudgetUsd ?? ""}
                      placeholder="uncapped"
                      onBlur={(e) =>
                        void save(instance.id, {
                          maxBudgetUsd: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Extra environment
                    <textarea
                      rows={3}
                      defaultValue={envToText(instance.env)}
                      placeholder="KEY=value, one per line"
                      onBlur={(e) => void save(instance.id, { env: envFromText(e.target.value) })}
                    />
                  </label>
                  <div className="provider-form-foot">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void remove(instance.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {adding ? (
        <div className="provider-catalog">
          <div className="provider-catalog-head">
            <span>Choose a provider</span>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          {DRIVER_CATALOG.map((entry) => (
            <button
              key={entry.driver}
              type="button"
              className="provider-catalog-item"
              onClick={() => void add(entry.driver, entry.label)}
            >
              <img src={PROVIDER_LOGOS[entry.driver]} alt="" width={22} height={22} />
              <span className="provider-row-titles">
                <span className="provider-row-name">{entry.label}</span>
                <span className="provider-row-driver dim">{entry.description}</span>
              </span>
              <span className="provider-catalog-add">Add</span>
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="provider-add-btn" onClick={() => setAdding(true)}>
          + Add provider
        </button>
      )}
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
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

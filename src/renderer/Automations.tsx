import { useEffect, useRef, useState } from "react";
import type {
  AutomationCadence,
  AutomationListItem,
  AutomationTemplate,
  ProjectListItem,
  ProviderName,
} from "../server/types.ts";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "./api.ts";
import { timeAgo } from "./format.ts";
import { PROVIDER_LOGOS, useProviderInstances } from "./providers.ts";
import { Icon } from "./icons.tsx";

const CADENCE_LABELS: Record<AutomationCadence, string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The minute steps the dialog offers; the store accepts any HH:MM. */
const MINUTES = ["00", "15", "30", "45"];

/** Prompt text flattened for card blurbs: markdown chrome out, one line. */
function blurb(prompt: string, length: number): string {
  const flat = prompt.replace(/[#*`>\n]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** What the dialog edits: a fresh row (blank or cut from a template) or an existing one. */
interface DialogSeed {
  automationId: number | null;
  title: string;
  category: string;
  priority: "low" | "medium" | "high";
  prompt: string;
  cadence: AutomationCadence;
  timeOfDay: string;
  dayOfWeek: number;
  projectId: number | null;
  /** A ProviderInstance id. */
  provider: string | null;
}

const BLANK_SEED: DialogSeed = {
  automationId: null,
  title: "",
  category: "general",
  priority: "medium",
  prompt: "",
  cadence: "manual",
  timeOfDay: "09:00",
  dayOfWeek: 1,
  projectId: null,
  provider: "claude-code",
};

/** What the template dialog edits; id null = creating a new template. */
interface TemplateSeed {
  id: number | null;
  title: string;
  category: string;
  priority: "low" | "medium" | "high";
  prompt: string;
}

const BLANK_TEMPLATE: TemplateSeed = {
  id: null,
  title: "",
  category: "general",
  priority: "medium",
  prompt: "",
};

function seedFromTemplate(template: AutomationTemplate): DialogSeed {
  return {
    ...BLANK_SEED,
    title: template.title,
    category: template.category,
    priority: template.priority,
    prompt: template.prompt,
  };
}

function seedFromAutomation(row: AutomationListItem): DialogSeed {
  return {
    automationId: row.id,
    title: row.title,
    category: row.category,
    priority: row.priority,
    prompt: row.prompt,
    cadence: row.cadence,
    timeOfDay: row.timeOfDay ?? "09:00",
    dayOfWeek: row.dayOfWeek ?? 1,
    projectId: row.projectId,
    // Older rows may predate the always-picked rule; land them on the first.
    provider: row.provider ?? "claude-code",
  };
}

/**
 * The Automations page (hosted in Home's nav like Workflows): standing
 * recurring agent tasks that fire as real Tickets on a Project's board, at a
 * time of the user's choosing or by hand. The built-in templates — v1's
 * recurring items — are the starting points.
 */
export function Automations() {
  const [rows, setRows] = useState<AutomationListItem[] | null>(null);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogSeed | null>(null);
  const [deleting, setDeleting] = useState<AutomationListItem | null>(null);
  const [templateDialog, setTemplateDialog] = useState<TemplateSeed | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<AutomationTemplate | null>(null);
  const [menuFor, setMenuFor] = useState<{ id: number; top: number; right: number } | null>(null);
  // The one-shot "fired" confirmation after Run now, keyed by automation id.
  const [ranId, setRanId] = useState<number | null>(null);

  const load = () =>
    Promise.all([
      apiGet<AutomationListItem[]>("/api/automations"),
      apiGet<AutomationTemplate[]>("/api/automation-templates"),
      apiGet<ProjectListItem[]>("/api/projects"),
    ])
      .then(([automations, templateRows, projectRows]) => {
        setRows(automations);
        setTemplates(templateRows);
        setProjects(projectRows);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  // Menus close like native ones: click elsewhere, Escape, or scroll.
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
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
  }, [menuFor]);

  const act = async (call: () => Promise<unknown>) => {
    try {
      await call();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runNow = (row: AutomationListItem) =>
    void act(async () => {
      await apiPost(`/api/automations/${row.id}/run`, {});
      setRanId(row.id);
      window.setTimeout(() => setRanId((current) => (current === row.id ? null : current)), 4000);
    });

  const shown = rows ?? [];

  return (
    <div className="home wf-library automations">
      <div className="home-picker wf-picker">
        <div className="home-header">
          <span className="home-title">Automations</span>
          <span className="home-header-actions">
            <button
              type="button"
              className="icon-btn"
              title="New automation"
              onClick={() => setDialog(BLANK_SEED)}
            >
              <Icon name="grid-plus" size={16} />
            </button>
          </span>
        </div>
        {error && <p className="banner error">{error}</p>}
        {rows !== null && rows.length === 0 && (
          <div className="auto-hero">
            <span className="auto-hero-glyph">
              <Icon name="bolt" size={28} />
            </span>
            <h2>Set up automations</h2>
            <p className="dim">
              Recurring agent tasks that fire on a cadence you choose and land as tickets on a
              project of your choosing. Start from scratch, or turn one of your templates below
              into an automation.
            </p>
            <button
              type="button"
              className="btn btn-primary auto-hero-cta"
              onClick={() => setDialog(BLANK_SEED)}
            >
              Start automating
            </button>
          </div>
        )}
        {shown.length > 0 && (
          <>
            <div className="auto-section-header">
              <span className="auto-section-title">Your automations</span>
              <span className="dim">
                Agents handle recurring work on a cadence you choose.
              </span>
            </div>
            <div className="auto-grid auto-grid-full">
              {shown.map((row) => (
                <div key={row.id} className={row.enabled ? "auto-card" : "auto-card paused"}>
                  <span className="auto-card-top">
                    <span className="auto-card-title">{row.title}</span>
                    <span className="auto-badge">{CADENCE_LABELS[row.cadence]}</span>
                  </span>
                  <span className="auto-card-desc dim">{blurb(row.prompt, 120)}</span>
                  <span className="auto-card-foot">
                    <span className="auto-card-meta dim">
                      {ranId === row.id ? (
                        <span className="wf-badge draft">Ticket created</span>
                      ) : !row.enabled ? (
                        <span className="wf-badge archived">Paused</span>
                      ) : row.projectId === null ? (
                        "no project yet"
                      ) : (
                        <>
                          {row.projectName}
                          {row.nextRunAt !== null &&
                            ` · next ${new Date(row.nextRunAt).toLocaleString([], {
                              weekday: "short",
                              hour: "numeric",
                              minute: "2-digit",
                            })}`}
                          {row.nextRunAt === null &&
                            row.lastFiredAt !== null &&
                            ` · ran ${timeAgo(row.lastFiredAt)}`}
                        </>
                      )}
                    </span>
                    <span className="auto-card-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title={row.projectId === null ? "Pick a project first" : "Run now"}
                        disabled={row.projectId === null}
                        onClick={() => runNow(row)}
                      >
                        <Icon name="play" size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn row-kebab"
                        title="More options"
                        aria-haspopup="menu"
                        aria-expanded={menuFor?.id === row.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          const anchor = e.currentTarget.getBoundingClientRect();
                          setMenuFor((open) =>
                            open?.id === row.id
                              ? null
                              : {
                                  id: row.id,
                                  top: anchor.bottom + 2,
                                  right: window.innerWidth - anchor.right,
                                },
                          );
                        }}
                      >
                        <Icon name="dots-horizontal" size={16} />
                      </button>
                    </span>
                  </span>
                  {menuFor?.id === row.id && (
                    <div
                      className="row-menu"
                      role="menu"
                      style={{ position: "fixed", top: menuFor.top, right: menuFor.right }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-item"
                        onClick={() => setDialog(seedFromAutomation(row))}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-item"
                        onClick={() =>
                          void act(() =>
                            apiPatch(`/api/automations/${row.id}`, { enabled: !row.enabled }),
                          )
                        }
                      >
                        {row.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-item danger"
                        onClick={() => setDeleting(row)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="auto-section-header">
          <span className="auto-section-title">
            Templates
            <button
              type="button"
              className="icon-btn auto-section-action"
              title="New template"
              onClick={() => setTemplateDialog(BLANK_TEMPLATE)}
            >
              <Icon name="plus-small" size={16} />
            </button>
          </span>
          <span className="dim">Turn a recurring task into an automation.</span>
        </div>
        <div className="auto-grid">
          {templates.map((template) => (
            <div
              key={template.id}
              className="auto-card template"
              role="button"
              tabIndex={0}
              onClick={() => setDialog(seedFromTemplate(template))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setDialog(seedFromTemplate(template));
                }
              }}
            >
              <span className="auto-card-top">
                <span className="auto-card-title">{template.title}</span>
              </span>
              <span className="auto-card-desc dim">{blurb(template.prompt, 140)}</span>
              <span className="auto-card-foot">
                <span className="auto-badge">{template.category}</span>
                <span className="auto-card-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Edit template"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTemplateDialog(template);
                    }}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Delete template"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingTemplate(template);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      {templateDialog && (
        <TemplateDialog
          seed={templateDialog}
          onCancel={() => setTemplateDialog(null)}
          onSaved={() => {
            setTemplateDialog(null);
            void load();
          }}
          onError={setError}
        />
      )}
      {deletingTemplate && (
        <div className="wf-overlay" onClick={() => setDeletingTemplate(null)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete template “{deletingTemplate.title}”?</h3>
            <p className="dim">
              Automations already created from it keep their prompts.
            </p>
            <div className="formrow">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const template = deletingTemplate;
                  setDeletingTemplate(null);
                  void act(() => apiDelete(`/api/automation-templates/${template.id}`));
                }}
              >
                Delete
              </button>
              <button type="button" className="btn" onClick={() => setDeletingTemplate(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <LaunchDialog
          seed={dialog}
          projects={projects}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
          onError={setError}
        />
      )}
      {deleting && (
        <div className="wf-overlay" onClick={() => setDeleting(null)}>
          <div className="wf-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{deleting.title}”?</h3>
            <p className="dim">
              The standing order goes away. Tickets it already created stay on their boards.
            </p>
            <div className="formrow">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const row = deleting;
                  setDeleting(null);
                  void act(() => apiDelete(`/api/automations/${row.id}`));
                }}
              >
                Delete
              </button>
              <button type="button" className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The create/edit dialog, laid out like Copilot's New automation: Name, a
 * Trigger / Hours / Minute row, the Prompt with the target picker riding in
 * its footer, and Create. Everything stays editable — a template is just a
 * prefill, never a lock.
 */
function LaunchDialog({
  seed,
  projects,
  onCancel,
  onSaved,
  onError,
}: {
  seed: DialogSeed;
  projects: ProjectListItem[];
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(seed);
  const [busy, setBusy] = useState(false);
  const instances = useProviderInstances();
  const patch = (change: Partial<DialogSeed>) => setForm((prev) => ({ ...prev, ...change }));
  const creating = seed.automationId === null;
  const [hour = "09", minute = "00"] = form.timeOfDay.split(":");

  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        title: form.title,
        category: form.category,
        priority: form.priority,
        prompt: form.prompt,
        cadence: form.cadence,
        timeOfDay: form.cadence === "manual" ? null : form.timeOfDay,
        dayOfWeek: form.cadence === "weekly" ? form.dayOfWeek : null,
        projectId: form.projectId,
        provider: form.provider,
      };
      if (creating) await apiPost("/api/automations", body);
      else await apiPatch(`/api/automations/${seed.automationId}`, body);
      onSaved();
    } catch (e) {
      onError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="wf-overlay" onClick={onCancel}>
      <div className="wf-dialog auto-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{creating ? "New automation" : "Edit automation"}</h3>
        <label className="wf-field">
          <span className="wf-field-label">Name</span>
          <input
            autoFocus={creating && seed.title === ""}
            value={form.title}
            placeholder="e.g. Issue triage"
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <div className="auto-trigger-row">
          <label className="wf-field">
            <span className="wf-field-label">Trigger</span>
            <select
              value={form.cadence}
              onChange={(e) => patch({ cadence: e.target.value as AutomationCadence })}
            >
              {(Object.keys(CADENCE_LABELS) as AutomationCadence[]).map((cadence) => (
                <option key={cadence} value={cadence}>
                  {CADENCE_LABELS[cadence]}
                </option>
              ))}
            </select>
          </label>
          {form.cadence === "weekly" && (
            <label className="wf-field">
              <span className="wf-field-label">Day</span>
              <select
                value={form.dayOfWeek}
                onChange={(e) => patch({ dayOfWeek: Number(e.target.value) })}
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.cadence !== "manual" && (
            <>
              <label className="wf-field">
                <span className="wf-field-label">Hours</span>
                <select
                  value={hour}
                  onChange={(e) => patch({ timeOfDay: `${e.target.value}:${minute}` })}
                >
                  {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).map((h) => (
                    <option key={h} value={h}>
                      {h}:00
                    </option>
                  ))}
                </select>
              </label>
              <label className="wf-field">
                <span className="wf-field-label">Minute</span>
                <select
                  value={MINUTES.includes(minute) ? minute : "00"}
                  onChange={(e) => patch({ timeOfDay: `${hour}:${e.target.value}` })}
                >
                  {MINUTES.map((m) => (
                    <option key={m} value={m}>
                      :{m}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <label className="wf-field">
          <span className="wf-field-label">Prompt</span>
          <textarea
            rows={6}
            value={form.prompt}
            placeholder="The ticket body the agent receives, verbatim"
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </label>
        <label className="wf-field">
          <span className="wf-field-label">Project</span>
          <select
            value={form.projectId ?? ""}
            onChange={(e) =>
              patch({ projectId: e.target.value === "" ? null : Number(e.target.value) })
            }
          >
            <option value="">Select project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="dim auto-field-hint">
            {form.projectId === null
              ? "Without a project, this automation can't fire."
              : "Each firing lands as a ticket on this project."}
          </span>
        </label>
        <div className="wf-field">
          <span className="wf-field-label">AI Agent</span>
          <div className="auto-agents" role="radiogroup" aria-label="AI agent">
            {(instances ?? [])
              .filter((i) => i.enabled || i.id === form.provider)
              .map((instance) => (
                <button
                  key={instance.id}
                  type="button"
                  role="radio"
                  aria-checked={form.provider === instance.id}
                  className={form.provider === instance.id ? "auto-agent selected" : "auto-agent"}
                  disabled={!instance.available}
                  title={instance.availabilityReason ?? undefined}
                  onClick={() => patch({ provider: instance.id })}
                >
                  <img src={PROVIDER_LOGOS[instance.driver]} alt="" width={18} height={18} />
                  {instance.displayName}
                </button>
              ))}
          </div>
        </div>
        <div className="auto-dialog-foot">
          <span className="dim">
            {creating ? "Use Run now on the card to test your prompt right away." : "Changes apply from the next firing."}
          </span>
          <div className="formrow">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || form.title.trim() === "" || form.prompt.trim() === ""}
              onClick={() => void submit()}
            >
              {creating ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Create/edit a template: the chip metadata and the prompt, nothing more. */
function TemplateDialog({
  seed,
  onCancel,
  onSaved,
  onError,
}: {
  seed: TemplateSeed;
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(seed);
  const [busy, setBusy] = useState(false);
  const patch = (change: Partial<TemplateSeed>) => setForm((prev) => ({ ...prev, ...change }));
  const creating = seed.id === null;

  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        title: form.title,
        category: form.category,
        priority: form.priority,
        prompt: form.prompt,
      };
      if (creating) await apiPost("/api/automation-templates", body);
      else await apiPatch(`/api/automation-templates/${seed.id}`, body);
      onSaved();
    } catch (e) {
      onError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="wf-overlay" onClick={onCancel}>
      <div className="wf-dialog auto-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{creating ? "New template" : "Edit template"}</h3>
        <label className="wf-field">
          <span className="wf-field-label">Name</span>
          <input
            autoFocus={creating}
            value={form.title}
            placeholder="e.g. Weekly dependency audit"
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <div className="auto-trigger-row">
          <label className="wf-field">
            <span className="wf-field-label">Category</span>
            <input
              value={form.category}
              placeholder="e.g. bugs"
              onChange={(e) => patch({ category: e.target.value })}
            />
          </label>
          <label className="wf-field">
            <span className="wf-field-label">Priority</span>
            <select
              value={form.priority}
              onChange={(e) => patch({ priority: e.target.value as TemplateSeed["priority"] })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <label className="wf-field">
          <span className="wf-field-label">Prompt</span>
          <textarea
            rows={8}
            value={form.prompt}
            placeholder="The ticket body an automation created from this template starts with"
            onChange={(e) => patch({ prompt: e.target.value })}
          />
        </label>
        <div className="auto-dialog-foot">
          <span className="dim">
            {creating
              ? "Templates are starting points — launching one copies the prompt."
              : "Automations already created from it keep their prompts."}
          </span>
          <div className="formrow">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || form.title.trim() === "" || form.prompt.trim() === ""}
              onClick={() => void submit()}
            >
              {creating ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

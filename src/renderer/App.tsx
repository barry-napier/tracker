import { useCallback, useEffect, useRef, useState } from "react";
import { getThemePref, setThemePref, type ThemePref } from "./theme.ts";
import {
  PROVIDERS,
  type Project,
  type ProviderName,
  type Repo,
  type TicketWithAcs,
} from "../server/types.ts";
import { apiGet, apiPost } from "./api.ts";
import { PROVIDER_LABELS, repoName } from "./format.ts";
import { avatarColor, Home } from "./Home.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
// PROTOTYPE (ticket 48) — mount gated behind /?prototype=canvas; remove with the prototype.
import { WorkflowCanvasPrototype } from "./WorkflowCanvasPrototype.tsx";

const CANVAS_PROTOTYPE = new URLSearchParams(location.search).get("prototype") === "canvas";
import { useBoard } from "./useBoard.ts";
import { ReviewWizard } from "./ReviewWizard.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { STATES } from "./ticketStates.ts";
import { loadTabs, saveTabs } from "./tabsState.ts";
import { Icon } from "./icons.tsx";

/**
 * Workspace state: open Project tabs plus one active view. Home is the
 * no-active-tab view — the Home button switches to it without closing tabs,
 * so an open board is always one click away. Opening a project adds a tab
 * (or re-activates an existing one); only the tab's × removes it.
 */
function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tabs, setTabs] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const project = tabs.find((t) => t.id === activeId) ?? null;
  const [repos, setRepos] = useState<Repo[]>([]);

  // The first fetch also restores last session's tabs — ids rehydrate from
  // live rows, so vanished projects drop instead of resurrecting.
  const restoredRef = useRef(false);
  const [fetchTick, setFetchTick] = useState(0);

  // Refetched on every return to Home so recents reorder by latest activity.
  useEffect(() => {
    if (project !== null) return;
    void apiGet<Project[]>("/api/projects")
      .then((rows) => {
        setProjects(rows);
        if (restoredRef.current) return;
        restoredRef.current = true;
        const saved = loadTabs(rows);
        setTabs(saved.tabs);
        setActiveId(saved.activeId);
        // Write back now: restore may have dropped vanished projects, and a
        // no-op setState won't re-fire the save effect below.
        saveTabs(saved.tabs, saved.activeId);
      })
      .catch(() => {
        // Boot race with the server: retry shortly. Persistence stays off
        // until a fetch lands, so a stale save can't clobber good storage.
        window.setTimeout(() => setFetchTick((tick) => tick + 1), 2000);
      });
  }, [project, fetchTick]);

  // Saves only after restore has run, so boot's empty state can't clobber
  // what the last session left behind.
  useEffect(() => {
    if (!restoredRef.current) return;
    saveTabs(tabs, activeId);
  }, [tabs, activeId]);

  // Repos follow the active tab.
  useEffect(() => {
    setRepos([]);
    if (activeId === null) return;
    void apiGet<Repo[]>(`/api/repos?projectId=${activeId}`).then(setRepos);
  }, [activeId]);

  const openProject = useCallback((opened: Project) => {
    setTabs((open) => (open.some((t) => t.id === opened.id) ? open : [...open, opened]));
    setActiveId(opened.id);
  }, []);

  // Fetch fallback: an "already tracked" click must open its Project even
  // when the recents list is stale or still in flight.
  const openProjectById = useCallback(
    async (id: number) => {
      const known = projects.find((p) => p.id === id);
      openProject(known ?? (await apiGet<Project>(`/api/projects/${id}`)));
    },
    [projects, openProject],
  );

  const goHome = useCallback(() => setActiveId(null), []);

  const activateTab = useCallback((id: number) => setActiveId(id), []);

  const closeTab = useCallback((id: number) => {
    setTabs((open) => open.filter((t) => t.id !== id));
    setActiveId((current) => (current === id ? null : current));
  }, []);

  // Removed from recents (ticket 50): drop the row without a refetch. An open
  // tab survives — hiding is a Home-list concern, not a tab concern.
  const forgetProject = useCallback((id: number) => {
    setProjects((rows) => rows.filter((p) => p.id !== id));
  }, []);

  return {
    projects,
    tabs,
    activeId,
    project,
    repos,
    openProject,
    openProjectById,
    activateTab,
    closeTab,
    forgetProject,
    goHome,
  };
}

export default function App() {
  const { board, error, loadAudit, loadRuns } = useBoard();
  const {
    projects,
    tabs,
    activeId,
    project,
    repos,
    openProject,
    openProjectById,
    activateTab,
    closeTab,
    forgetProject,
    goHome,
  } = useWorkspace();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reviewId, setReviewId] = useState<number | null>(null);
  // Home hosts two views (CONTEXT.md): Recent Projects and the app-global
  // Workflow library. Pure view state — the tab model never hears about it.
  const [homeView, setHomeView] = useState<"projects" | "workflows">("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The stream carries every project; the board shows only the active tab's.
  const tickets = project ? board.tickets.filter((t) => t.projectId === project.id) : [];
  // Scoped to the active tab, so switching tabs drops another board's overlays.
  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  // Live row from board state, so SSE updates keep the wizard chrome honest.
  const reviewing = tickets.find((t) => t.id === reviewId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          title="Home"
          onClick={goHome}
          aria-pressed={project === null}
        >
          <Icon name="grid-plus" size={16} />
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeId ? "tab active" : "tab"}
            onClick={() => activateTab(tab.id)}
          >
            <span className="avatar" style={{ background: avatarColor(tab.name) }}>
              {tab.name.slice(0, 1).toUpperCase()}
            </span>
            {tab.name}
            <span
              role="button"
              tabIndex={0}
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  closeTab(tab.id);
                }
              }}
            >
              <Icon name="close-small" size={14} />
            </span>
          </button>
        ))}
        <span className="topbar-actions">
          <ThemeToggle />
          {project && (
            <button
              type="button"
              className="icon-btn"
              title={`${project.name} settings`}
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings-gear" />
            </button>
          )}
          <button type="button" className="icon-btn" title="Help">
            <Icon name="help" />
          </button>
        </span>
      </header>
      <main className="main">
        {error && <p className="banner error">Can't reach the Tracker server: {error}</p>}
        {!project && CANVAS_PROTOTYPE && <WorkflowCanvasPrototype />}
        {!project && !CANVAS_PROTOTYPE && homeView === "projects" && (
          <Home
            projects={projects}
            onOpen={(id) => void openProjectById(id)}
            onCreated={openProject}
            onHidden={forgetProject}
          />
        )}
        {!project && !CANVAS_PROTOTYPE && homeView === "workflows" && <WorkflowLibrary />}
        {!project && (
          <nav className="home-nav">
            {(["projects", "workflows"] as const).map((view) => (
              <button
                key={view}
                type="button"
                className={homeView === view ? "active" : undefined}
                onClick={() => setHomeView(view)}
              >
                {view === "projects" ? "Projects" : "Workflows"}
              </button>
            ))}
          </nav>
        )}
        {project && selected && (
          <TicketDetail
            ticket={selected}
            projectName={project.name}
            repos={repos}
            audit={board.auditByTicket[selected.id] ?? []}
            runs={board.runsByTicket[selected.id] ?? []}
            loadAudit={loadAudit}
            loadRuns={loadRuns}
            onClose={() => setSelectedId(null)}
          />
        )}
        {project && !selected && (
        <div className="board">
          {STATES.map(({ key, label }) => {
            const column = tickets.filter((t) => t.state === key);
            return (
              <section key={key} className="column">
                <h3>
                  {label} <span className="dim">{column.length}</span>
                </h3>
                {key === "backlog" && <NewTicketForm projectId={project.id} />}
                {column.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    project={ticket.state === "backlog" ? project : null}
                    repos={repos}
                    onOpen={() => setSelectedId(ticket.id)}
                    onReview={
                      ticket.state === "human_review" ? () => setReviewId(ticket.id) : null
                    }
                  />
                ))}
              </section>
            );
          })}
        </div>
        )}
      </main>
      {project && reviewing && (
        <ReviewWizard ticket={reviewing} onClose={() => setReviewId(null)} />
      )}
      {project && settingsOpen && (
        <ProjectSettings
          key={project.id}
          project={project}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const THEME_LABELS: Record<ThemePref, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const cycle = () => {
    const next = THEME_CYCLE[pref];
    setThemePref(next);
    setPref(next);
  };
  return (
    <button
      type="button"
      className="themebtn"
      onClick={cycle}
      title="Cycle color scheme (auto / light / dark)"
    >
      ◐ {THEME_LABELS[pref]}
    </button>
  );
}

function TicketCard({
  ticket,
  project,
  repos,
  onOpen,
  onReview,
}: {
  ticket: TicketWithAcs;
  /** Non-null only on Backlog cards, where the promote control lives. */
  project: Project | null;
  repos: Repo[];
  onOpen: () => void;
  /** Non-null only on Human Review cards, which carry the Review → button. */
  onReview: (() => void) | null;
}) {
  return (
    <article className="card" onClick={onOpen}>
      <span className="dim">{ticket.displayKey}</span>
      <p>{ticket.title}</p>
      {(ticket.provider || ticket.acceptanceCriteria.length > 0) && (
        <em className="dim">
          {ticket.provider && PROVIDER_LABELS[ticket.provider]}
          {ticket.provider && ticket.acceptanceCriteria.length > 0 && " · "}
          {ticket.acceptanceCriteria.length > 0 &&
            `${ticket.acceptanceCriteria.length} AC${ticket.acceptanceCriteria.length === 1 ? "" : "s"}`}
        </em>
      )}
      {project && <PromoteControl ticket={ticket} project={project} repos={repos} />}
      {onReview && (
        <button
          className="reviewbtn"
          onClick={(e) => {
            e.stopPropagation();
            onReview();
          }}
        >
          Review →
        </button>
      )}
    </article>
  );
}

/** Promotion is the single deliberate "go": pick Repo + provider on the card. */
function PromoteControl({
  ticket,
  project,
  repos,
}: {
  ticket: TicketWithAcs;
  project: Project;
  repos: Repo[];
}) {
  const [open, setOpen] = useState(false);
  // Derived, not initial-state: repos may arrive after this card mounts.
  const [pickedRepoId, setPickedRepoId] = useState<number | null>(null);
  const repoId = pickedRepoId ?? repos[0]?.id ?? null;
  const [provider, setProvider] = useState<ProviderName>(project.defaultProvider);
  const [error, setError] = useState<string | null>(null);

  if (repos.length === 0) {
    return <em className="dim">Register a repo to promote</em>;
  }
  if (!open) {
    return (
      <button
        className="promote"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Promote →
      </button>
    );
  }

  const submit = async () => {
    if (repoId === null) return;
    try {
      // No optimistic move: the card changes column when ticket.updated
      // arrives over SSE, so what renders is what the store persisted.
      await apiPost(`/api/tickets/${ticket.id}/promote`, { repoId, provider });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="promoteform" onClick={(e) => e.stopPropagation()}>
      <label>
        Repo
        <select
          value={repoId ?? undefined}
          onChange={(e) => setPickedRepoId(Number(e.target.value))}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoName(repo)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider
        <ProviderSelect value={provider} onChange={setProvider} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="formrow">
        <button onClick={() => void submit()}>Promote to Todo</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function ProviderSelect({
  value,
  onChange,
}: {
  value: ProviderName;
  onChange: (provider: ProviderName) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ProviderName)}>
      {PROVIDERS.map((p) => (
        <option key={p} value={p}>
          {PROVIDER_LABELS[p]}
        </option>
      ))}
    </select>
  );
}

function NewTicketForm({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acs, setAcs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOpen(false);
    setTitle("");
    setDescription("");
    setAcs("");
    setError(null);
  };

  const submit = async () => {
    if (title.trim() === "") return;
    try {
      // No optimistic insert: the card appears when ticket.updated arrives
      // over SSE, so what renders is what the store persisted.
      await apiPost("/api/tickets", {
        projectId,
        title: title.trim(),
        description,
        acceptanceCriteria: acs
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) {
    return (
      <button className="newticket" onClick={() => setOpen(true)}>
        + New ticket
      </button>
    );
  }
  return (
    <form
      className="newform"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        placeholder="Description"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        placeholder={"Acceptance criteria — one per line"}
        rows={3}
        value={acs}
        onChange={(e) => setAcs(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="formrow">
        <button type="submit" disabled={title.trim() === ""}>
          File ticket
        </button>
        <button type="button" onClick={reset}>
          Cancel
        </button>
      </div>
    </form>
  );
}

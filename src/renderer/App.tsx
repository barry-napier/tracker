import { useCallback, useEffect, useRef, useState } from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router";
import { getThemePref, setThemePref, type ThemePref } from "./theme.ts";
import type {
  Project,
  ProjectListItem,
  Repo,
  RepoListItem,
  TicketWithAcs,
} from "../server/types.ts";
import type { SweepResult } from "../server/sweep.ts";
import { apiGet, apiPatch, apiPost } from "./api.ts";
import { PROVIDER_LABELS, repoName } from "./format.ts";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { avatarColor, Home } from "./Home.tsx";
import { Automations } from "./Automations.tsx";
import { TeamWork } from "./TeamWork.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { WorkflowCreate, WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowCanvasEditor } from "./WorkflowCanvasEditor.tsx";
import type { WorkflowListing } from "../server/types.ts";
import { useBoard } from "./useBoard.ts";
import { ReviewWizard } from "./ReviewWizard.tsx";
import { AgentLogs } from "./AgentLogs.tsx";
import { ArtifactViewer } from "./ArtifactViewer.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { STATES } from "./ticketStates.ts";
import { StateIcon } from "./stateIcons.tsx";
import {
  applyControls,
  BoardToolbar,
  initialControls,
  MonthView,
} from "./boardTools.tsx";
import { loadTabs, saveTabs } from "./tabsState.ts";
import { TerminalDrawer } from "./TerminalDrawer.tsx";
import { RightSidebar, type BrowseRequest } from "./RightSidebar.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { IntakeNew, IntakeView } from "./IntakeView.tsx";
import { KindIcon } from "./kindIcons.tsx";
import { AuthContext, fetchAuthStatus, type AuthStatus } from "./auth.ts";
import { SignIn } from "./SignIn.tsx";
import {
  SettingsConnections,
  SettingsGeneral,
  SettingsProviders,
  SettingsShell,
} from "./Settings.tsx";

/**
 * The URL is the view state: every surface has a route (hash-based, since
 * Electron loads the renderer over file://), so refresh and back/forward
 * land where you were. The /projects/:id prefix IS the "active tab" —
 * nothing else remembers which board is showing.
 */
function projectIdFromPath(pathname: string): number | null {
  const match = /^\/projects\/(\d+)/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * Workspace state: open Project tabs plus the URL-derived active view. Home
 * is the no-project route — the Home button navigates there without closing
 * tabs, so an open board is always one click away. Opening a project adds a
 * tab (or re-activates an existing one); only the tab's × removes it. A deep
 * link to a project with no tab fetches the row and opens one.
 */
function useWorkspace() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeId = projectIdFromPath(pathname);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  // Boot splash gate: stays false until the first successful fetch, so the
  // splash covers both the server boot race and the initial render.
  const [booted, setBooted] = useState(false);
  const [tabs, setTabs] = useState<Project[]>([]);
  const project = tabs.find((t) => t.id === activeId) ?? null;
  const [repos, setRepos] = useState<RepoListItem[]>([]);

  // The first fetch also restores last session's tabs — ids rehydrate from
  // live rows, so vanished projects drop instead of resurrecting.
  const restoredRef = useRef(false);
  const [fetchTick, setFetchTick] = useState(0);
  // Effects read the path at fire time without re-running on every navigation.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Refetched on every return to Home so recents reorder by latest activity.
  useEffect(() => {
    if (activeId !== null) return;
    // Archived rows come too — Home's "Show archived" pref decides visibility.
    void apiGet<ProjectListItem[]>("/api/projects?includeHidden=1")
      .then((rows) => {
        setProjects(rows);
        setBooted(true);
        if (restoredRef.current) return;
        restoredRef.current = true;
        const saved = loadTabs(rows);
        // Merge, not replace: a deep link's ensure-tab fetch may already
        // have landed its tab before this restore ran.
        setTabs((current) => [
          ...saved.tabs,
          ...current.filter((t) => !saved.tabs.some((s) => s.id === t.id)),
        ]);
        // Write back now: restore may have dropped vanished projects, and a
        // no-op setState won't re-fire the save effect below.
        saveTabs(saved.tabs, saved.activeId);
        // Fresh boot lands on "/" (packaged loads carry no hash): reopen the
        // last session's active board. A deep link anywhere else wins.
        if (saved.activeId !== null && pathRef.current === "/") {
          navigate(`/projects/${saved.activeId}`, { replace: true });
        }
      })
      .catch(() => {
        // Boot race with the server: retry shortly. Persistence stays off
        // until a fetch lands, so a stale save can't clobber good storage.
        window.setTimeout(() => setFetchTick((tick) => tick + 1), 2000);
      });
  }, [activeId, fetchTick, navigate]);

  // Saves only after restore has run, so boot's empty state can't clobber
  // what the last session left behind.
  useEffect(() => {
    if (!restoredRef.current) return;
    saveTabs(tabs, activeId);
  }, [tabs, activeId]);

  // A deep link (or restored URL) to a project with no open tab: fetch the
  // row and open one. An unknown id degrades to Home rather than a dead view.
  useEffect(() => {
    if (activeId === null || tabs.some((t) => t.id === activeId)) return;
    let live = true;
    void apiGet<Project>(`/api/projects/${activeId}`)
      .then((row) => {
        if (!live) return;
        setBooted(true);
        setTabs((open) => (open.some((t) => t.id === row.id) ? open : [...open, row]));
      })
      .catch(() => {
        if (live) navigate("/", { replace: true });
      });
    return () => {
      live = false;
    };
  }, [activeId, tabs, navigate]);

  // Repos follow the active tab.
  useEffect(() => {
    setRepos([]);
    if (activeId === null) return;
    void apiGet<RepoListItem[]>(`/api/repos?projectId=${activeId}`).then(setRepos);
  }, [activeId]);

  const openProject = useCallback(
    (opened: Project) => {
      setTabs((open) => (open.some((t) => t.id === opened.id) ? open : [...open, opened]));
      navigate(`/projects/${opened.id}`);
    },
    [navigate],
  );

  // Fetch fallback: an "already tracked" click must open its Project even
  // when the recents list is stale or still in flight.
  const openProjectById = useCallback(
    async (id: number) => {
      const known = projects.find((p) => p.id === id);
      openProject(known ?? (await apiGet<Project>(`/api/projects/${id}`)));
    },
    [projects, openProject],
  );

  const closeTab = useCallback(
    (id: number) => {
      setTabs((open) => open.filter((t) => t.id !== id));
      if (projectIdFromPath(pathRef.current) === id) navigate("/");
    },
    [navigate],
  );

  // Archived / unarchived from recents (ticket 50): patch the row without a
  // refetch. An open tab survives — archiving is a Home-list concern, not a
  // tab concern.
  const setProjectHiddenAt = useCallback((id: number, hiddenAt: string | null) => {
    setProjects((rows) => rows.map((p) => (p.id === id ? { ...p, hiddenAt } : p)));
  }, []);

  // Soft-deleted: the row leaves every listing, so drop it — and close its
  // tab, since a deleted project's board is no longer a place to be.
  const dropProject = useCallback(
    (id: number) => {
      setProjects((rows) => rows.filter((p) => p.id !== id));
      setTabs((open) => open.filter((t) => t.id !== id));
      if (projectIdFromPath(pathRef.current) === id) navigate("/");
    },
    [navigate],
  );

  // A server-confirmed change to a project row (workflow pick, "Keep it")
  // lands in the tab cache too, so row-gated UI (the confirm banner) can't
  // resurrect from a stale tab on the next visit.
  const updateTab = useCallback((row: Project) => {
    setTabs((open) => open.map((t) => (t.id === row.id ? row : t)));
  }, []);

  return {
    booted,
    projects,
    tabs,
    activeId,
    project,
    repos,
    openProject,
    openProjectById,
    closeTab,
    setProjectHiddenAt,
    dropProject,
    updateTab,
  };
}

/** Everything the routed views need, provided once by the Shell's Outlet. */
type ShellContext = ReturnType<typeof useWorkspace> &
  ReturnType<typeof useBoard> & {
    /** Show a URL in the right sidebar's Browser surface (opens the panel). */
    openInSidebar: (url: string) => void;
  };

function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

/**
 * The launch gate (ADR-0006): one status fetch at boot decides between the
 * SignIn screen and the app. Status is instant (a cached DB row), so the
 * gate resolves before the splash would have finished anyway.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const refresh = useCallback(
    async () => setStatus(await fetchAuthStatus().catch(() => null)),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === null) return null; // server still booting — splash territory
  if (status.required && !status.authenticated) {
    return <SignIn onSignedIn={() => void refresh()} />;
  }
  return (
    <AuthContext.Provider value={{ user: status.user ?? null, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export default function App() {
  return (
    <AuthGate>
      <AppRoutes />
    </AuthGate>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="settings" element={<SettingsShell />}>
        <Route index element={<Navigate to="general" replace />} />
        <Route path="general" element={<SettingsGeneral />} />
        <Route path="connections" element={<SettingsConnections />} />
        <Route path="providers" element={<SettingsProviders />} />
      </Route>
      <Route element={<Shell />}>
        <Route index element={<HomeRoute />} />
        <Route path="team" element={<TeamWork />} />
        <Route path="workflows" element={<WorkflowsRoute />} />
        <Route path="automations" element={<Automations />} />
        <Route path="workflows/new" element={<WorkflowCreateRoute />} />
        <Route path="workflows/:workflowId" element={<WorkflowEditorRoute />} />
        <Route path="projects/:projectId" element={<BoardRoute />} />
        <Route path="projects/:projectId/settings" element={<BoardRoute overlay="settings" />} />
        <Route path="projects/:projectId/intake/new" element={<IntakeNewRoute />} />
        <Route path="projects/:projectId/intake/:sessionId" element={<IntakeRoute />} />
        <Route path="projects/:projectId/tickets/:ticketId" element={<TicketRoute />} />
        <Route path="projects/:projectId/tickets/:ticketId/logs" element={<TicketLogsRoute />} />
        <Route
          path="projects/:projectId/tickets/:ticketId/artifacts/:artifactId?"
          element={<TicketArtifactsRoute />}
        />
        <Route
          path="projects/:projectId/tickets/:ticketId/review"
          element={<BoardRoute overlay="review" />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}


/**
 * Boot splash: the app chrome renders as normal underneath, but Home's picker
 * and the view switch hide (via `.app.booting`) and only the wordmark shows,
 * centered on screen. Once the first fetch lands the wordmark flies (FLIP)
 * into Home's wordmark — or fades out when the session restored straight into
 * a project board — then onDone lets the hidden pieces fade in.
 */
function BootSplash({ booted, onDone }: { booted: boolean; onDone: () => void }) {
  const wordmarkRef = useRef<HTMLHeadingElement>(null);
  const shownAt = useRef(performance.now());
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!booted) return;
    // Restored straight into a board (or any non-Home route): the wordmark
    // has nowhere to land and must never linger over the board — drop the
    // splash immediately, no hold, no fade.
    const splash = wordmarkRef.current;
    const target = document.querySelector<HTMLElement>(".home .wordmark");
    if (!splash || !target) {
      if (splash) splash.style.display = "none";
      doneRef.current();
      return;
    }
    // Hold briefly so a near-instant boot doesn't strobe the splash.
    const hold = Math.max(0, 400 - (performance.now() - shownAt.current));
    const timer = window.setTimeout(() => {
      // The real wordmark stays hidden by `.app.booting` until onDone, so
      // only the splash copy is visible; it lands exactly, then hands off.
      const from = splash.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const flight = splash.animate(
        [
          { transform: "translate(0, 0)" },
          { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px)` },
        ],
        { duration: 500, easing: "cubic-bezier(0.3, 0.9, 0.35, 1)", fill: "forwards" },
      );
      flight.onfinish = () => doneRef.current();
    }, hold);
    return () => window.clearTimeout(timer);
  }, [booted]);

  return (
    <div className="boot-splash" aria-hidden="true">
      <h1 className="wordmark" ref={wordmarkRef}>
        tracker
      </h1>
    </div>
  );
}

/** Topbar + home-nav chrome around every route; state flows via Outlet context. */
function Shell() {
  const boardApi = useBoard();
  const workspace = useWorkspace();
  const { tabs, project } = workspace;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The canvas editor is a focused surface — no view switcher there; its own
  // back button is the way out.
  const inCanvasEditor = /^\/workflows\/\d+/.test(pathname);
  const workflowsActive = pathname.startsWith("/workflows");
  const teamActive = pathname.startsWith("/team");
  const automationsActive = pathname.startsWith("/automations");

  // The terminal drawer (⌘J): the main card slides up and a shell appears
  // beneath it. Closing hides the drawer but keeps the shell session alive.
  const [termOpen, setTermOpen] = useState(false);
  // Boot splash: chrome renders from the start, but Home's picker and the
  // view switch stay hidden until the wordmark lands, then fade in.
  const [booting, setBooting] = useState(true);
  // The right sidebar (⌘L): a surface picker (browser, terminal, …) beside
  // the main card.
  const [rightOpen, setRightOpen] = useState(false);
  // Pages ask the sidebar's Browser surface to show a URL (Team's PR rows);
  // the tick lets the same URL be requested twice in a row.
  const [browseTo, setBrowseTo] = useState<BrowseRequest | null>(null);
  const openInSidebar = useCallback((url: string) => {
    setRightOpen(true);
    setBrowseTo((prev) => ({ url, tick: (prev?.tick ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        setTermOpen((open) => !open);
      } else if (key === "l") {
        e.preventDefault();
        setRightOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={booting ? "app booting" : "app"}>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          title="Home"
          onClick={() => navigate("/")}
          aria-pressed={project === null}
        >
          <Icon name="grid-plus" size={16} />
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === project?.id ? "tab active" : "tab"}
            onClick={() => navigate(`/projects/${tab.id}`)}
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
                workspace.closeTab(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  workspace.closeTab(tab.id);
                }
              }}
            >
              <Icon name="close-small" size={14} />
            </span>
          </button>
        ))}
        <span className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            title="Settings"
            onClick={() => navigate("/settings/general")}
          >
            <Icon name="settings-gear" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Toggle terminal drawer (⌘J)"
            aria-pressed={termOpen}
            onClick={() => setTermOpen((open) => !open)}
          >
            <Icon name={termOpen ? "layout-bottom-partial" : "layout-bottom"} size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Toggle right sidebar (⌘L)"
            aria-pressed={rightOpen}
            onClick={() => setRightOpen((open) => !open)}
          >
            <Icon name={rightOpen ? "layout-right-partial" : "layout-right"} size={16} />
          </button>
          {project && (
            <button
              type="button"
              className="icon-btn"
              title={`${project.name} settings`}
              onClick={() => navigate(`/projects/${project.id}/settings`)}
            >
              <Icon name="settings-gear" />
            </button>
          )}
        </span>
      </header>
      <div className="app-body">
        <div className="app-center">
          <main className="main">
        {boardApi.error && (
          <p className="banner error">Can't reach the Tracker server: {boardApi.error}</p>
        )}
        <Outlet context={{ ...boardApi, ...workspace, openInSidebar }} />
        {!project && !inCanvasEditor && (
          <nav className="home-nav">
            <button
              type="button"
              className={workflowsActive || automationsActive || teamActive ? undefined : "active"}
              onClick={() => navigate("/")}
            >
              Projects
            </button>
            <button
              type="button"
              className={workflowsActive ? "active" : undefined}
              onClick={() => navigate("/workflows")}
            >
              Workflows
            </button>
            <button
              type="button"
              className={automationsActive ? "active" : undefined}
              onClick={() => navigate("/automations")}
            >
              Automations
            </button>
            <button
              type="button"
              className={teamActive ? "active" : undefined}
              onClick={() => navigate("/team")}
            >
              Team
            </button>
          </nav>
        )}
      </main>
          <TerminalDrawer open={termOpen} onClose={() => setTermOpen(false)} />
        </div>
        <RightSidebar open={rightOpen} projectId={project?.id ?? null} browseTo={browseTo} />
      </div>
      {booting && <BootSplash booted={workspace.booted} onDone={() => setBooting(false)} />}
    </div>
  );
}

function HomeRoute() {
  const { projects, openProject, openProjectById, setProjectHiddenAt, dropProject } = useShell();
  return (
    <Home
      projects={projects}
      onOpen={(id) => void openProjectById(id)}
      onCreated={openProject}
      onArchivedChange={setProjectHiddenAt}
      onDeleted={dropProject}
    />
  );
}

function WorkflowsRoute() {
  const navigate = useNavigate();
  return (
    <WorkflowLibrary
      onCreateNew={() => navigate("/workflows/new")}
      onOpenEditor={(row) => navigate(`/workflows/${row.id}`)}
    />
  );
}

function WorkflowCreateRoute() {
  const navigate = useNavigate();
  return (
    <WorkflowCreate
      onDone={() => navigate("/workflows")}
      onCreated={(id) => navigate(`/workflows/${id}`)}
    />
  );
}

/**
 * The canvas editor deep-links by id, but there's no single-row GET — the
 * listing is small, so refetch it and pick the row. A vanished workflow
 * bounces to the library rather than rendering a dead editor.
 */
function WorkflowEditorRoute() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const id = Number(workflowId);
  const [row, setRow] = useState<WorkflowListing | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setRow(undefined);
    void apiGet<WorkflowListing[]>("/api/workflows")
      .then((rows) => {
        if (live) setRow(rows.find((r) => r.id === id) ?? null);
      })
      .catch(() => {
        if (live) setRow(null);
      });
    return () => {
      live = false;
    };
  }, [id]);
  if (row === undefined) return null;
  if (row === null) return <Navigate to="/workflows" replace />;
  return <WorkflowCanvasEditor key={row.id} workflow={row} onClose={() => navigate("/workflows")} />;
}

/** The active tab's slice of the board stream. */
function useProjectTickets(): TicketWithAcs[] {
  const { board, project } = useShell();
  return project ? board.tickets.filter((t) => t.projectId === project.id) : [];
}

/**
 * The board, optionally with a route-driven overlay: settings and the review
 * wizard are still modals visually, but the URL owns whether they're open —
 * refresh restores them, back closes them.
 */
function BoardRoute({ overlay }: { overlay?: "settings" | "review" }) {
  const { project, repos, updateTab } = useShell();
  const navigate = useNavigate();
  const { ticketId } = useParams();
  const tickets = useProjectTickets();
  // Tab still opening (deep link's fetch in flight) — or about to bounce Home.
  if (!project) return null;
  // Live row from board state, so SSE updates keep the wizard chrome honest.
  const reviewing =
    overlay === "review" ? (tickets.find((t) => t.id === Number(ticketId)) ?? null) : null;
  return (
    <>
      <Board project={project} tickets={tickets} repos={repos} />
      {reviewing && (
        <ReviewWizard ticket={reviewing} onClose={() => navigate(`/projects/${project.id}`)} />
      )}
      {overlay === "settings" && (
        <ProjectSettings
          key={project.id}
          project={project}
          onClose={() => navigate(`/projects/${project.id}`)}
          onSaved={updateTab}
        />
      )}
    </>
  );
}

function IntakeNewRoute() {
  const { project, repos } = useShell();
  if (!project) return null;
  return <IntakeNew key={project.id} project={project} repos={repos} />;
}

function IntakeRoute() {
  const { project } = useShell();
  const { sessionId } = useParams();
  if (!project) return null;
  return <IntakeView key={sessionId} sessionId={Number(sessionId)} projectId={project.id} />;
}

function TicketRoute() {
  const { project, repos, board, loadAudit, loadRuns } = useShell();
  const navigate = useNavigate();
  const { ticketId } = useParams();
  const tickets = useProjectTickets();
  if (!project) return null;
  const selected = tickets.find((t) => t.id === Number(ticketId)) ?? null;  // Not (yet) in the stream — show the board rather than a dead detail view.
  if (!selected) return <Board project={project} tickets={tickets} repos={repos} />;
  return (
    <TicketDetail
      ticket={selected}
      projectName={project.name}
      repos={repos}
      audit={board.auditByTicket[selected.id] ?? []}
      runs={board.runsByTicket[selected.id] ?? []}
      loadAudit={loadAudit}
      loadRuns={loadRuns}
      onClose={() => navigate(`/projects/${project.id}`)}
      onOpenLogs={() => navigate(`/projects/${project.id}/tickets/${selected.id}/logs`)}
      onOpenReview={() => navigate(`/projects/${project.id}/tickets/${selected.id}/review`)}
      onOpenArtifact={(artifactId) =>
        navigate(`/projects/${project.id}/tickets/${selected.id}/artifacts/${artifactId}`)
      }
    />
  );
}

/** The run conversation as its own full-screen surface (v1's LogsView). */
function TicketLogsRoute() {
  const { project, board, loadRuns } = useShell();
  const navigate = useNavigate();
  const { ticketId } = useParams();
  const tickets = useProjectTickets();
  if (!project) return null;
  const selected = tickets.find((t) => t.id === Number(ticketId)) ?? null;
  if (!selected) return <Navigate to={`/projects/${project.id}`} replace />;
  return (
    <AgentLogs
      ticket={selected}
      runs={board.runsByTicket[selected.id] ?? []}
      loadRuns={loadRuns}
      onBack={() => navigate(`/projects/${project.id}/tickets/${selected.id}`)}
    />
  );
}

/** Persisted run artifacts as a full-screen surface; the URL owns the pick. */
function TicketArtifactsRoute() {
  const { project, board, loadRuns } = useShell();
  const navigate = useNavigate();
  const { ticketId, artifactId } = useParams();
  const tickets = useProjectTickets();
  if (!project) return null;
  const selected = tickets.find((t) => t.id === Number(ticketId)) ?? null;
  if (!selected) return <Navigate to={`/projects/${project.id}`} replace />;
  const base = `/projects/${project.id}/tickets/${selected.id}`;
  return (
    <ArtifactViewer
      ticket={selected}
      runs={board.runsByTicket[selected.id] ?? []}
      loadRuns={loadRuns}
      selectedId={artifactId ? Number(artifactId) : null}
      onSelect={(id) => navigate(`${base}/artifacts/${id}`, { replace: true })}
      onBack={() => navigate(base)}
    />
  );
}

/**
 * The board's one-time ask: a project created without an explicit workflow
 * choice banners until the user keeps the default or picks another (via
 * settings, where any pick confirms server-side). Local state hides it
 * immediately on "Keep" — the tab's cached project row updates on next hydrate.
 */
function WorkflowConfirmBanner({ project }: { project: Project }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { updateTab } = useShell();
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<WorkflowListing[]>("/api/workflows")
      .then((rows) => setName(rows.find((w) => w.id === project.workflowId)?.name ?? null))
      .catch(() => {});
  }, [project.workflowId]);

  // A pick inside settings confirms server-side; the tab's cached row can't
  // know. Re-check the live row whenever the route changes (settings closing
  // included) — and write the answer back to the tab cache, so the banner
  // never mounts again once the question is answered.
  useEffect(() => {
    void apiGet<Project>(`/api/projects/${project.id}`)
      .then((live) => {
        setConfirmed(live.workflowConfirmed);
        if (live.workflowConfirmed) updateTab(live);
      })
      .catch(() => {});
  }, [project.id, pathname, updateTab]);

  if (confirmed) return null;
  const keep = async () => {
    setConfirmed(true);
    try {
      const live = await apiPatch<Project>(`/api/projects/${project.id}`, {
        workflowConfirmed: true,
      });
      updateTab(live);
    } catch {
      setConfirmed(false);
    }
  };
  return (
    <div className="banner wf-confirm">
      <span>
        This project uses the <strong>{name ?? "default"}</strong> workflow. Keep it or pick
        another?
      </span>
      <button type="button" onClick={() => void keep()}>
        Keep it
      </button>
      <button type="button" onClick={() => navigate(`/projects/${project.id}/settings`)}>
        Pick another…
      </button>
    </div>
  );
}

/**
 * A picked folder git doesn't own still opens as a board (the server
 * registers it uninitialised); this is the board's offer to `git init` it.
 * Local state hides the banner on success — the server's gitMissing flag is
 * derived from disk, so the next repos fetch agrees on its own.
 */
function GitInitBanner({ repo }: { repo: RepoListItem }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");

  if (state === "done") return null;
  const init = async () => {
    setState("busy");
    try {
      await apiPost(`/api/repos/${repo.id}/git-init`, {});
      setState("done");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="banner git-init">
      <span>
        {state === "failed" ? (
          <>
            Couldn’t initialise git in <strong>{repoName(repo)}</strong> — try again?
          </>
        ) : (
          <>
            <strong>{repoName(repo)}</strong> isn’t a git repository yet. Tracker needs one
            to run tickets.
          </>
        )}
      </span>
      <button type="button" disabled={state === "busy"} onClick={() => void init()}>
        {state === "busy" ? "Initialising…" : "Initialise git"}
      </button>
    </div>
  );
}

function Board({
  project,
  tickets,
  repos,
}: {
  project: Project;
  tickets: TicketWithAcs[];
  repos: RepoListItem[];
}) {
  const navigate = useNavigate();
  const uninitialized = repos.find((r) => r.gitMissing) ?? null;
  const [controls, setControls] = useState(initialControls);
  // Repo filter (?repo=<name>): the URL owns it, so a filtered board is
  // bookmarkable and survives refresh. An unknown name reads as "all".
  const [searchParams, setSearchParams] = useSearchParams();
  const repoParam = searchParams.get("repo");
  const filteredRepo = repoParam ? (repos.find((r) => repoName(r) === repoParam) ?? null) : null;
  const visibleTickets = filteredRepo
    ? tickets.filter((t) => t.repoId === filteredRepo.id)
    : tickets;
  const setRepoFilter = (id: number | null) => {
    const next = new URLSearchParams(searchParams);
    const picked = repos.find((r) => r.id === id);
    if (picked) next.set("repo", repoName(picked));
    else next.delete("repo");
    setSearchParams(next, { replace: true });
  };
  return (
    <>
      {uninitialized && <GitInitBanner key={uninitialized.id} repo={uninitialized} />}
      {!project.workflowConfirmed && <WorkflowConfirmBanner key={project.id} project={project} />}
      <BoardToolbar
        controls={controls}
        onChange={setControls}
        repoOptions={repos.map((r) => ({ id: r.id, name: repoName(r) }))}
        repoFilter={filteredRepo?.id ?? null}
        onRepoFilter={setRepoFilter}
        actions={
          <>
            <DoneSweep projectId={project.id} />
            <IntakeLaunch project={project} repos={repos} />
          </>
        }
      />
      {controls.view === "month" ? (
        <MonthView
          tickets={visibleTickets}
          onOpenWeek={(weekStart) => setControls({ ...controls, weekStart, view: "board" })}
          onOpenTicket={(t) => navigate(`/projects/${project.id}/tickets/${t.id}`)}
        />
      ) : (
      <div className="board">
      {STATES.map(({ key, label }) => {
        const column = applyControls(visibleTickets, key, controls);
        return (
          <section key={key} className="column">
            <h3 className="column-head">
              <StateIcon state={key} />
              <span className="column-label">{label}</span>
              <span
                className={
                  "column-count" +
                  (key === "human_review" && column.length > 0 ? " column-count-warn" : "")
                }
              >
                {column.length}
              </span>
            </h3>
            {column.length === 0 && <div className="column-empty">No issues</div>}
            {column.map((ticket) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                project={ticket.state === "backlog" ? project : null}
                repos={repos}
                onOpen={() => navigate(`/projects/${project.id}/tickets/${ticket.id}`)}
                onReview={
                  ticket.state === "human_review"
                    ? () => navigate(`/projects/${project.id}/tickets/${ticket.id}/review`)
                    : null
                }
              />
            ))}
          </section>
        );
      })}
      </div>
      )}
    </>
  );
}

/** Re-renders subscribers once a minute so waiting badges stay honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "45m" / "3.2h" / "4.4d" since the ticket entered its current column. */
function waitingLabel(sinceIso: string, now: number): string | null {
  const mins = (now - new Date(sinceIso).getTime()) / 60_000;
  if (mins < 60) return null; // fresh moves aren't "waiting"
  if (mins < 60 * 24) return `waiting ${(mins / 60).toFixed(1)}h`;
  return `waiting ${(mins / (60 * 24)).toFixed(1)}d`;
}

const FMT_CREATED = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

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
  const now = useNow();
  const waiting =
    ticket.state !== "backlog" && ticket.state !== "done"
      ? waitingLabel(ticket.updatedAt, now)
      : null;
  const repo = repos.find((r) => r.id === ticket.repoId) ?? null;
  // Passed the gates: parked tickets (cap or setup failure) don't count.
  const verified =
    (ticket.state === "human_review" || ticket.state === "done") &&
    !ticket.arrivedByCap &&
    !ticket.lastFailureReason;
  return (
    <article className="card" onClick={onOpen}>
      <div className="card-top">
        <span className="card-key dim">
          <KindIcon kind={ticket.kind} size={14} />
          {ticket.displayKey}
        </span>
        {ticket.provider && (
          <span className="card-provider">
            {PROVIDER_LABELS[ticket.provider] ?? ticket.provider}
          </span>
        )}
      </div>
      <p className="card-title">
        <StateIcon state={ticket.state} />
        {ticket.title}
      </p>
      {(waiting || repo) && (
        <div className="card-chips">
          {waiting && (
            <span className={"chip " + (waiting.endsWith("d") ? "chip-danger" : "chip-warn")}>
              {waiting}
            </span>
          )}
          {repo && <span className="chip">{repoName(repo)}</span>}
        </div>
      )}
      {(ticket.branch || ticket.prNumber !== null) && (
        <div className="card-chips">
          {ticket.branch && (
            <span className="chip chip-mono" title={ticket.branch}>
              {ticket.branch}
            </span>
          )}
          {ticket.prNumber !== null &&
            (ticket.prUrl ? (
              <a
                className="chip chip-info"
                href={ticket.prUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                #{ticket.prNumber}
              </a>
            ) : (
              <span className="chip chip-info">#{ticket.prNumber}</span>
            ))}
        </div>
      )}
      {(verified || ticket.bounceCount > 0 || ticket.acceptanceCriteria.length > 0) && (
        <div className="card-chips">
          {verified && <span className="chip chip-ok">✓ Verified</span>}
          {ticket.bounceCount > 0 && (
            <span className="chip chip-warn" title="Failed attempts so far">
              ↺ {ticket.bounceCount}
            </span>
          )}
          {ticket.acceptanceCriteria.length > 0 && (
            <span className="chip">
              {ticket.acceptanceCriteria.length} AC
              {ticket.acceptanceCriteria.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
      {ticket.lastFailureReason && (
        <em className="error" title={ticket.lastFailureReason}>
          {ticket.lastFailureReason}
        </em>
      )}
      {project && <PromoteControl ticket={ticket} project={project} repos={repos} />}
      <div className="card-footer">
        <span className="dim">Created {FMT_CREATED.format(new Date(ticket.createdAt))}</span>
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
        {onReview && ticket.lastFailureReason && (
          <button
            className="reviewbtn"
            title="Send back to Todo for another attempt"
            onClick={(e) => {
              e.stopPropagation();
              void apiPost(`/api/tickets/${ticket.id}/retry`, {});
            }}
          >
            ↺ Retry
          </button>
        )}
      </div>
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
  const [provider, setProvider] = useState<string>(project.defaultProvider);
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
        <ProviderPicker value={provider} onChange={setProvider} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="formrow">
        <button onClick={() => void submit()}>Promote to Todo</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}


/**
 * The worktree sweep (ticket 42): Done does not auto-destroy — this toolbar
 * button is the deliberate reap of merged-and-persisted tickets' worktrees
 * and preview records. The report shows in a popover until dismissed; skips
 * are always shown with their reason, never silent.
 */
function DoneSweep({ projectId }: { projectId: number }) {
  const [report, setReport] = useState<SweepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching tabs must not carry another board's sweep story along.
  useEffect(() => {
    setReport(null);
    setError(null);
  }, [projectId]);

  // Any outside click or Escape dismisses the report, matching the sort popover.
  const noteOpen = report !== null || error !== null;
  useEffect(() => {
    if (!noteOpen) return;
    const close = () => {
      setReport(null);
      setError(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [noteOpen]);

  const sweep = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiPost<SweepResult>(`/api/projects/${projectId}/sweep`, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="toolbar-action">
      <button
        type="button"
        className="weeknav"
        onClick={(e) => {
          // The document-level closer sees this click too; stop it so a
          // fresh report isn't immediately dismissed.
          e.stopPropagation();
          void sweep();
        }}
        disabled={busy}
        title="Reap merged tickets' worktrees and preview records"
      >
        {busy ? "Sweeping…" : "⌁ Sweep worktrees"}
      </button>
      {noteOpen && (
        <div className="row-menu sweep-pop" onClick={(e) => e.stopPropagation()}>
          {error && <p className="sweep-note sweep-error">{error}</p>}
          {report && (
            <div className="sweep-note">
              <p>
                {report.reaped.length === 0
                  ? "Nothing to reap."
                  : `Reaped ${report.reaped.map((r) => r.displayKey).join(", ")}.`}
              </p>
              {report.skipped.map((skip) => (
                <p key={skip.ticketId}>
                  {skip.displayKey} skipped — {skip.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ticket creation IS the AI intake (the manual form is gone): the toolbar
 * button opens the full-page intake composer, where the kind, intent, and
 * provider are picked and the grilling starts.
 */
function IntakeLaunch({ project, repos }: { project: Project; repos: RepoListItem[] }) {
  const navigate = useNavigate();
  if (repos.length === 0) return null;
  return (
    <div className="toolbar-action">
      <button
        type="button"
        className="toolbar-new"
        onClick={() => navigate(`/projects/${project.id}/intake/new`)}
        title="An intake agent researches the repo, grills you on the real decisions, and drafts the ticket"
      >
        + New ticket
      </button>
    </div>
  );
}

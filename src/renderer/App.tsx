import { useCallback, useEffect, useState } from "react";
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
import { useBoard } from "./useBoard.ts";
import { ReviewWizard } from "./ReviewWizard.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { STATES } from "./ticketStates.ts";

/**
 * Project + Repo registration state. Single-project workspace for now: the
 * first project wins; creating one is the empty-state setup step.
 */
function useWorkspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void apiGet<Project[]>("/api/projects").then(async (projects) => {
      const first = projects[0] ?? null;
      setProject(first);
      if (first) setRepos(await apiGet<Repo[]>(`/api/repos?projectId=${first.id}`));
      setLoaded(true);
    });
  }, []);

  const createProject = useCallback(async (name: string, defaultProvider: ProviderName) => {
    setProject(await apiPost<Project>("/api/projects", { name, defaultProvider }));
  }, []);

  const createRepo = useCallback(
    async (input: { path: string; githubRemote: string; targetBranch: string }) => {
      if (!project) return;
      const repo = await apiPost<Repo>("/api/repos", { projectId: project.id, ...input });
      setRepos((existing) => [...existing, repo]);
    },
    [project],
  );

  return { project, repos, loaded, createProject, createRepo };
}

export default function App() {
  const { board, error, loadAudit, loadRuns } = useBoard();
  const { project, repos, loaded, createProject, createRepo } = useWorkspace();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = board.tickets.find((t) => t.id === selectedId) ?? null;
  const [reviewId, setReviewId] = useState<number | null>(null);
  // Live row from board state, so SSE updates keep the wizard chrome honest.
  const reviewing = board.tickets.find((t) => t.id === reviewId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <b>Tracker</b>
        {project && <span className="dim">/ {project.name}</span>}
        {project && <RepoBar repos={repos} onCreate={createRepo} />}
        <ThemeToggle />
      </header>
      {error && <p className="banner error">Can't reach the Tracker server: {error}</p>}
      {loaded && !project && <ProjectSetup onCreate={createProject} />}
      <div className="board">
        {STATES.map(({ key, label }) => {
          const column = board.tickets.filter((t) => t.state === key);
          return (
            <section key={key} className="column">
              <h3>
                {label} <span className="dim">{column.length}</span>
              </h3>
              {key === "backlog" && project && <NewTicketForm projectId={project.id} />}
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
      {selected && (
        <TicketDetail
          ticket={selected}
          repos={repos}
          audit={board.auditByTicket[selected.id] ?? []}
          runs={board.runsByTicket[selected.id] ?? []}
          loadAudit={loadAudit}
          loadRuns={loadRuns}
          onClose={() => setSelectedId(null)}
        />
      )}
      {reviewing && <ReviewWizard ticket={reviewing} onClose={() => setReviewId(null)} />}
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

function ProjectSetup({
  onCreate,
}: {
  onCreate: (name: string, defaultProvider: ProviderName) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderName>("claude-code");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="newform setup"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(name.trim(), provider).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <h3>Register a project</h3>
      <input
        autoFocus
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label>
        Default provider
        <ProviderSelect value={provider} onChange={setProvider} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="formrow">
        <button type="submit" disabled={name.trim() === ""}>
          Create project
        </button>
      </div>
    </form>
  );
}

function RepoBar({
  repos,
  onCreate,
}: {
  repos: Repo[];
  onCreate: (input: { path: string; githubRemote: string; targetBranch: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="repobar">
      <span className="dim">
        {repos.length === 0 ? "No repos" : repos.map(repoName).join(", ")}
      </span>
      <button className="addrepo" onClick={() => setOpen(!open)}>
        + Add repo
      </button>
      {open && (
        <form
          className="newform repoform"
          onSubmit={(e) => {
            e.preventDefault();
            onCreate({ path: path.trim(), githubRemote: remote.trim(), targetBranch: branch.trim() })
              .then(() => {
                setOpen(false);
                setPath("");
                setRemote("");
                setBranch("main");
                setError(null);
              })
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
              });
          }}
        >
          <input
            autoFocus
            placeholder="Local path (/Users/you/dev/app)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <input
            placeholder="GitHub remote (git@github.com:you/app.git)"
            value={remote}
            onChange={(e) => setRemote(e.target.value)}
          />
          <input
            placeholder="Target branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <div className="formrow">
            <button type="submit" disabled={path.trim() === "" || remote.trim() === ""}>
              Register repo
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </span>
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

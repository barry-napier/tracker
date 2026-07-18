import { useEffect, useState } from "react";
import type { Project, TicketWithAcs } from "../server/types.ts";
import { apiGet, apiPost } from "./api.ts";
import { useBoard } from "./useBoard.ts";
import { TicketDetail } from "./TicketDetail.tsx";
import { STATES } from "./ticketStates.ts";

/** First project wins for now; real Project/Repo registration is slice 24. */
function useDefaultProject(): Project | null {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    void apiGet<Project[]>("/api/projects").then(async (projects) => {
      setProject(projects[0] ?? (await apiPost<Project>("/api/projects", { name: "Inbox" })));
    });
  }, []);
  return project;
}

export default function App() {
  const { board, error, loadAudit } = useBoard();
  const project = useDefaultProject();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = board.tickets.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <b>Tracker</b>
        {project && <span className="dim">/ {project.name}</span>}
      </header>
      {error && <p className="banner error">Can't reach the Tracker server: {error}</p>}
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
                <TicketCard key={ticket.id} ticket={ticket} onOpen={() => setSelectedId(ticket.id)} />
              ))}
            </section>
          );
        })}
      </div>
      {selected && (
        <TicketDetail
          ticket={selected}
          audit={board.auditByTicket[selected.id] ?? []}
          loadAudit={loadAudit}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function TicketCard({ ticket, onOpen }: { ticket: TicketWithAcs; onOpen: () => void }) {
  return (
    <article className="card" onClick={onOpen}>
      <span className="dim">{ticket.displayKey}</span>
      <p>{ticket.title}</p>
      {ticket.acceptanceCriteria.length > 0 && (
        <em className="dim">
          {ticket.acceptanceCriteria.length} AC{ticket.acceptanceCriteria.length === 1 ? "" : "s"}
        </em>
      )}
    </article>
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

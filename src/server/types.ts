export const PROVIDERS = ["claude-code", "kiro", "copilot"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface Project {
  id: number;
  name: string;
  ticketPrefix: string;
  defaultProvider: Provider;
  createdAt: string;
}

export type PreviewKind = "ui" | "api";

export interface Repo {
  id: number;
  projectId: number;
  path: string;
  githubRemote: string;
  targetBranch: string;
  // Preview config exists from registration onward but is unused until slice 34.
  previewCommand: string | null;
  previewKind: PreviewKind | null;
  previewReadinessPath: string | null;
  createdAt: string;
}

export type TicketState =
  | "backlog"
  | "todo"
  | "in_progress"
  | "verifying"
  | "human_review"
  | "done";

export interface Ticket {
  id: number;
  projectId: number;
  displayKey: string;
  title: string;
  description: string;
  state: TicketState;
  /** Null until promotion; promotion targets exactly one Repo. */
  repoId: number | null;
  /** Null until promotion; picked per-ticket, defaulted from the Project. */
  provider: Provider | null;
  createdAt: string;
  updatedAt: string;
}

export type AcStatus = "pending" | "verified" | "failed" | "waived";
export type AcOrigin = "original" | "gate-fail" | "review-fail";

export interface AcceptanceCriterion {
  id: number;
  ticketId: number;
  text: string;
  position: number;
  status: AcStatus;
  origin: AcOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface TicketWithAcs extends Ticket {
  acceptanceCriteria: AcceptanceCriterion[];
}

export type Actor = "human" | "agent";

export interface AuditEvent {
  id: number;
  projectId: number | null;
  ticketId: number | null;
  actor: Actor;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

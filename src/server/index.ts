import { serve } from "@hono/node-server";
import { ArtifactStore } from "./artifacts.ts";
import { Bouncer } from "./bounce.ts";
import { EventBus } from "./bus.ts";
import { openDatabase } from "./db.ts";
import { DemoRecorder } from "./demos.ts";
import { createApp } from "./app.ts";
import { WorkflowEngine, type PhaseTimeouts } from "./engine.ts";
import { GateBattery } from "./gates.ts";
import { GhGitHub, type GitHubPort } from "./github.ts";
import { Home } from "./home.ts";
import { PreviewManager } from "./previews.ts";
import type { ProviderRegistry } from "./provider.ts";
import type { ProviderConfigReader } from "./providers/registry.ts";
import { Reviews } from "./reviews.ts";
import { RunLogRegistry } from "./runlog.ts";
import { Store } from "./store.ts";
import { DoneSweeper } from "./sweep.ts";
import { Verdicts } from "./verdicts.ts";
import { sweepOrphanedRuns, WorkerPool } from "./workers.ts";
import { WorktreeManager } from "./worktrees.ts";

/** Every worktree path some ticket still accounts for (ticket 42). */
function accountedWorktreePaths(store: Store, worktrees: WorktreeManager): Set<string> {
  const keep = new Set<string>();
  for (const ticket of store.listTickets()) {
    if (ticket.repoId === null) continue;
    const repo = store.getRepo(ticket.repoId);
    if (repo) keep.add(worktrees.worktreePath(repo, ticket.displayKey));
  }
  return keep;
}

export interface TrackerServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: {
  dataDir: string;
  port: number;
  /** Worker-pool size; see WorkerPool for the default's rationale. 0 disables claims. */
  workers?: number;
  /**
   * Provider adapters by name; a claim on an unregistered provider crashes
   * its run. Pass a function to build the registry against the app's live
   * provider config (ticket 38) — adapters that read it per phase pick up a
   * settings edit without a restart. Tests pass a plain registry.
   */
  providers?: ProviderRegistry | ((config: ProviderConfigReader) => ProviderRegistry);
  /** GitHub seam for the battery's gates and the merge path; defaults to `gh`. */
  github?: GitHubPort;
  /** Preview port-preference base (ticket 10); tests offset it per worker. */
  previewPortBase?: number;
  /** Per-phase watchdog overrides (ticket 41); tests shrink them. */
  phaseTimeouts?: PhaseTimeouts;
}): Promise<TrackerServer> {
  const db = openDatabase(options.dataDir);
  const bus = new EventBus();
  const store = new Store(db, bus);
  const runLogs = new RunLogRegistry();
  const github = options.github ?? new GhGitHub();
  const artifacts = new ArtifactStore(options.dataDir, store);
  // One Bouncer serves both bounce triggers: the battery's (WorkerPool) and
  // the reviewer's (Verdicts) — same machinery, same report shape.
  const bouncer = new Bouncer(store, artifacts);
  const worktrees = new WorktreeManager(options.dataDir);
  // No process survives a restart: rows still claiming live catch up first —
  // preview records silently, orphaned Runs through the crash policy
  // (ticket 41), and worktree dirs no ticket accounts for (ticket 42) —
  // all before the pool below can claim anything.
  store.sweepOrphanedPreviews();
  await sweepOrphanedRuns(store, artifacts);
  await worktrees.removeOrphanDirs(accountedWorktreePaths(store, worktrees));
  const previews = new PreviewManager(options.dataDir, store, options.previewPortBase);
  const providers =
    typeof options.providers === "function"
      ? options.providers((provider) => store.getProviderConfig(provider))
      : (options.providers ?? {});
  const app = createApp(
    store,
    bus,
    runLogs,
    new Verdicts(store, github, bouncer),
    new Reviews(store, github),
    new Home(store),
    previews,
    new DoneSweeper(store, worktrees, previews, artifacts, github),
    options.dataDir,
    providers,
  );
  const engine = new WorkflowEngine(store, providers, runLogs, previews, options.phaseTimeouts);
  const pool = new WorkerPool(
    store,
    worktrees,
    engine,
    artifacts,
    new DemoRecorder(options.dataDir, store, previews, artifacts),
    new GateBattery(store, github),
    bouncer,
    options.workers ?? 3,
  );
  pool.start(bus);

  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port, hostname: "127.0.0.1" },
      (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          port: info.port,
          close: async () => {
            await pool.stop();
            await previews.stopAll();
            await new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) => (error ? rejectClose(error) : resolveClose()));
              // SSE clients hold connections open; drop them so close() returns.
              if ("closeAllConnections" in server) server.closeAllConnections();
              db.close();
            });
          },
        });
      },
    );
    // Without this, a failed bind (port taken) leaves the promise pending
    // forever — the app would sit windowless with no error.
    server.once("error", (error) => {
      void pool.stop().catch(() => {});
      try {
        db.close();
      } catch {
        // Already closed or busy — the reject below is the news that matters.
      }
      reject(error);
    });
  });
}

import { serve } from "@hono/node-server";
import { ArtifactStore } from "./artifacts.ts";
import { Bouncer } from "./bounce.ts";
import { EventBus } from "./bus.ts";
import { openDatabase } from "./db.ts";
import { DemoRecorder } from "./demos.ts";
import { createApp } from "./app.ts";
import { WorkflowEngine } from "./engine.ts";
import { GateBattery } from "./gates.ts";
import { GhGitHub, type GitHubPort } from "./github.ts";
import { Home } from "./home.ts";
import { PreviewManager } from "./previews.ts";
import type { ProviderRegistry } from "./provider.ts";
import { Reviews } from "./reviews.ts";
import { RunLogRegistry } from "./runlog.ts";
import { Store } from "./store.ts";
import { Verdicts } from "./verdicts.ts";
import { WorkerPool } from "./workers.ts";
import { WorktreeManager } from "./worktrees.ts";

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
  /** Provider adapters by name; a claim on an unregistered provider crashes its run. */
  providers?: ProviderRegistry;
  /** GitHub seam for the battery's gates and the merge path; defaults to `gh`. */
  github?: GitHubPort;
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
  // No process survives a restart: rows still claiming live catch up first.
  store.sweepOrphanedPreviews();
  const previews = new PreviewManager(options.dataDir, store);
  const app = createApp(
    store,
    bus,
    runLogs,
    new Verdicts(store, github, bouncer),
    new Reviews(store, github),
    new Home(store, github),
    previews,
    options.dataDir,
  );
  const engine = new WorkflowEngine(store, options.providers ?? {}, runLogs);
  const pool = new WorkerPool(
    store,
    new WorktreeManager(options.dataDir),
    engine,
    artifacts,
    new DemoRecorder(options.dataDir, store, previews, artifacts),
    new GateBattery(store, github),
    bouncer,
    options.workers ?? 3,
  );
  pool.start(bus);

  return new Promise((resolve) => {
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
  });
}

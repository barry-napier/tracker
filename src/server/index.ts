import { serve } from "@hono/node-server";
import { ArtifactStore } from "./artifacts.ts";
import { Bouncer } from "./bounce.ts";
import { EventBus } from "./bus.ts";
import { openDatabase } from "./db.ts";
import { createApp } from "./app.ts";
import { WorkflowEngine } from "./engine.ts";
import { GateBattery } from "./gates.ts";
import { NullGitHub, type GitHubPort } from "./github.ts";
import type { ProviderRegistry } from "./provider.ts";
import { RunLogRegistry } from "./runlog.ts";
import { Store } from "./store.ts";
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
  /** GitHub seam for the battery's gates; defaults to the pre-slice-31 stand-in. */
  github?: GitHubPort;
}): Promise<TrackerServer> {
  const db = openDatabase(options.dataDir);
  const bus = new EventBus();
  const store = new Store(db, bus);
  const runLogs = new RunLogRegistry();
  const app = createApp(store, bus, runLogs);
  const engine = new WorkflowEngine(store, options.providers ?? {}, runLogs);
  const artifacts = new ArtifactStore(options.dataDir, store);
  const pool = new WorkerPool(
    store,
    new WorktreeManager(options.dataDir),
    engine,
    artifacts,
    new GateBattery(store, options.github ?? new NullGitHub()),
    new Bouncer(store, artifacts),
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

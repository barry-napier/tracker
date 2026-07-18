import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderRegistry } from "../src/server/provider.ts";
import { startServer, type TrackerServer } from "../src/server/index.ts";
import { initScratchRepo } from "./git-helpers.ts";

export const cleanups: Array<() => Promise<void>> = [];

export async function bootServer(
  dataDir?: string,
  options: { workers?: number; providers?: ProviderRegistry } = {},
): Promise<TrackerServer> {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), "tracker-test-")));
  // Workers default off: earlier-slice tests register repos at fake paths
  // and must not have the factory try to clone them.
  const server = await startServer({
    dataDir: dir,
    port: 0,
    workers: options.workers ?? 0,
    providers: options.providers,
  });
  cleanups.push(async () => {
    await server.close();
    if (!dataDir) await rm(dir, { recursive: true, force: true });
  });
  return server;
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!();
}

/** Project + registered scratch repo, ready for promotion to trigger claims. */
export async function seedWorkspace(
  server: TrackerServer,
): Promise<{ source: string; project: any; repo: any }> {
  const source = initScratchRepo("fixture-app");
  cleanups.push(() => rm(path.dirname(source), { recursive: true, force: true }));
  const project = (await api(server, "POST", "/api/projects", { name: "Fixture App" })).json;
  const repo = (
    await api(server, "POST", "/api/repos", {
      projectId: project.id,
      path: source,
      githubRemote: "git@github.com:barry/fixture-app.git",
    })
  ).json;
  return { source, project, repo };
}

export async function api(
  server: TrackerServer,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.url}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type TrackerServer } from "../src/server/index.ts";

export const cleanups: Array<() => Promise<void>> = [];

export async function bootServer(
  dataDir?: string,
  options: { workers?: number } = {},
): Promise<TrackerServer> {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), "tracker-test-")));
  // Workers default off: earlier-slice tests register repos at fake paths
  // and must not have the factory try to clone them.
  const server = await startServer({ dataDir: dir, port: 0, workers: options.workers ?? 0 });
  cleanups.push(async () => {
    await server.close();
    if (!dataDir) await rm(dir, { recursive: true, force: true });
  });
  return server;
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!();
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

import path from "node:path";
import { appProviders } from "../src/server/providers/registry.ts";
import { startServer } from "../src/server/index.ts";

// Headless Tracker server for renderer dev (`vite dev` has no Electron main
// process to start one). State lives in .dev-data/, ignored by git.
const server = await startServer({
  dataDir: path.join(import.meta.dirname, "..", ".dev-data"),
  port: Number(process.env.TRACKER_PORT ?? process.env.PORT ?? 4400),
  // Same registry as the packaged app: Claude Code is real (ticket 38),
  // Kiro and Copilot stay scripted until their slices land.
  providers: appProviders,
});
console.log(`Tracker API listening at ${server.url}`);

// Previews are detached process groups; a bare kill would orphan them.
// Electron's before-quit runs close() — the dev server must match it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

import path from "node:path";
import { demoProviders } from "../src/server/providers/demo.ts";
import { startServer } from "../src/server/index.ts";

// Headless Tracker server for renderer dev (`vite dev` has no Electron main
// process to start one). State lives in .dev-data/, ignored by git.
const server = await startServer({
  dataDir: path.join(import.meta.dirname, "..", ".dev-data"),
  port: Number(process.env.TRACKER_PORT ?? 4400),
  providers: demoProviders(),
});
console.log(`Tracker API listening at ${server.url}`);

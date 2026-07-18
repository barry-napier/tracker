import { defineConfig } from "vite";

// No react plugin: esbuild's automatic JSX runtime covers TSX, and skipping
// the plugin's inline dev preamble lets index.html keep a strict CSP.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  build: {
    outDir: "../../build/renderer",
    emptyOutDir: true,
  },
  // PORT lets a second dev session (or the preview harness) avoid collisions.
  server: { port: Number(process.env.PORT ?? 5199) },
});

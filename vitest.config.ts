import { defineConfig } from "vitest/config";

// Only the repo's own suite: worktrees under .dev-data are full checkouts
// (agent runs write checks/*.spec.ts and carry tests/ copies) and must never
// leak into this repo's `npm test`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

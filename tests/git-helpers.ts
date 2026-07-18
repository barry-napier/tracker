import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A throwaway repo playing the user's checkout: one commit on `main`. */
export function initScratchRepo(name = "scratch-app"): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "tracker-git-")), name);
  execFileSync("git", ["init", "-b", "main", dir], { encoding: "utf8" });
  git(dir, "config", "user.email", "test@tracker.local");
  git(dir, "config", "user.name", "Tracker Test");
  commit(dir, "README.md", "# scratch\n", "initial commit");
  return dir;
}

export function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

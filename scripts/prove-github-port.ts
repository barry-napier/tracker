/**
 * The real-`gh` proof for ticket 31: drives GhGitHub — the production
 * GitHubPort backing — end to end against a scratch GitHub repo. Creates the
 * repo, pushes main and a feature branch, then asks every port question for
 * real: branch-recorded, pr-fresh (PR head SHA vs branch tip), mergeability,
 * merge. Prints a PASS/FAIL line per check; exits non-zero on any failure.
 *
 *   node scripts/prove-github-port.ts [owner/repo]
 *
 * The scratch repo is created private and deleted at the end (deletion needs
 * the delete_repo scope; without it the script tells you what to remove).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GhGitHub } from "../src/server/github.ts";

const slug = process.argv[2] ?? "barry-napier/tracker-gh-proof";
const remote = `https://github.com/${slug}.git`;
const branch = "feat/proof";
const github = new GhGitHub();

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

function run(cwd: string | undefined, file: string, ...args: string[]): string {
  return execFileSync(file, args, { cwd, encoding: "utf8" }).trim();
}

console.log(`Scratch repo: ${slug}`);
run(undefined, "gh", "repo", "create", slug, "--private");
const workdir = mkdtempSync(path.join(tmpdir(), "gh-proof-"));

try {
  // A main branch and a feature branch, both really pushed.
  run(undefined, "git", "init", "-b", "main", workdir);
  run(workdir, "git", "remote", "add", "origin", remote);
  writeFileSync(path.join(workdir, "README.md"), "# gh-proof scratch\n");
  run(workdir, "git", "add", "README.md");
  run(workdir, "git", "commit", "-m", "initial commit");
  run(workdir, "git", "push", "-u", "origin", "main");
  run(workdir, "git", "checkout", "-b", branch);
  writeFileSync(path.join(workdir, "widget.txt"), "the widget\n");
  run(workdir, "git", "add", "widget.txt");
  run(workdir, "git", "commit", "-m", "add widget");
  run(workdir, "git", "push", "-u", "origin", branch);
  const tip = run(workdir, "git", "rev-parse", "HEAD");

  check("branch-recorded: pushed branch exists", await github.branchExists(remote, branch));
  check("branch-recorded: unpushed branch does not", !(await github.branchExists(remote, "feat/never-pushed")));
  check("findPr before create is null", (await github.findPr(remote, branch)) === null);

  const created = await github.createPr(remote, {
    branch,
    targetBranch: "main",
    title: "gh-proof: the widget",
    body: "Opened by scripts/prove-github-port.ts (ticket 31).",
  });
  check("createPr returns the PR", created.number > 0, `#${created.number} ${created.url}`);

  const found = await github.findPr(remote, branch);
  check("findPr finds the open PR", found?.number === created.number);
  check("pr-fresh: PR head SHA == branch tip", found?.headSha === tip, `${found?.headSha} vs ${tip}`);

  // GitHub computes mergeability async; give it a moment.
  let mergeability = await github.mergeability(remote, created.number);
  for (let i = 0; i < 10 && mergeability === "unknown"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    mergeability = await github.mergeability(remote, created.number);
  }
  check("mergeability settles mergeable", mergeability === "mergeable", mergeability);

  await github.mergePr(remote, created.number);
  const state = run(undefined, "gh", "pr", "view", String(created.number), "--repo", slug, "--json", "state", "--jq", ".state");
  check("mergePr: GitHub reports the PR merged", state === "MERGED", state);
  check("merged PR is no longer the open PR", (await github.findPr(remote, branch)) === null);
} finally {
  rmSync(workdir, { recursive: true, force: true });
  try {
    run(undefined, "gh", "repo", "delete", slug, "--yes");
    console.log(`Deleted scratch repo ${slug}`);
  } catch {
    console.log(`Could not delete ${slug} (needs the delete_repo scope) — remove it by hand or run:`);
    console.log(`  gh auth refresh -h github.com -s delete_repo && gh repo delete ${slug} --yes`);
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git, initScratchRepo } from "./git-helpers.ts";
import { FakeGitHub } from "./github-fake.ts";
import { api, bootServer, runCleanups, seedWorkspace, FIXTURE_REMOTE } from "./server-helpers.ts";

afterEach(runCleanups);

/** An affiliated repo on the fake GitHub, backed by a real local repo so clone works. */
function seedAffiliated(
  github: FakeGitHub,
  nameWithOwner: string,
  overrides: { description?: string | null; defaultBranch?: string } = {},
): { sshUrl: string; source: string } {
  const source = initScratchRepo(nameWithOwner.split("/")[1]!);
  // The local remote's HEAD branch IS the default branch, as on GitHub.
  if (overrides.defaultBranch && overrides.defaultBranch !== "main") {
    git(source, "branch", "-m", "main", overrides.defaultBranch);
  }
  const sshUrl = `git@github.com:${nameWithOwner}.git`;
  github.registerRemote(sshUrl, source);
  github.registerAffiliatedRepo({
    nameWithOwner,
    sshUrl,
    description: overrides.description ?? null,
    defaultBranch: overrides.defaultBranch ?? "main",
  });
  return { sshUrl, source };
}

describe("Home: affiliated repo listing (ticket A)", () => {
  test("lists affiliated repos and flags the ones already tracked", async () => {
    const github = new FakeGitHub();
    seedAffiliated(github, "barry/fixture-app");
    seedAffiliated(github, "barry/other-app", { description: "spare" });
    const server = await bootServer(undefined, { github });
    // Registers a Repo on FIXTURE_REMOTE = git@github.com:barry/fixture-app.git.
    const { project } = await seedWorkspace(server);

    const res = await api(server, "GET", "/api/github/repos");
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.json.repos.map((r: any) => [r.nameWithOwner, r]),
    );
    expect(byName["barry/fixture-app"].trackedProjectId).toBe(project.id);
    expect(byName["barry/other-app"]).toMatchObject({
      trackedProjectId: null,
      description: "spare",
      defaultBranch: "main",
    });
  });

  test("degrades honestly when no GitHub backing is configured", async () => {
    const server = await bootServer(); // NullGitHub
    const res = await api(server, "GET", "/api/github/repos");
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("no GitHub backing");
  });
});

describe("Home: clone from GitHub (ticket A)", () => {
  test("clones into <parent>/<repo-name> and registers Project + Repo with derived defaults", async () => {
    const github = new FakeGitHub();
    const { sshUrl } = seedAffiliated(github, "barry/widget-press", {
      defaultBranch: "trunk",
    });
    const server = await bootServer(undefined, { github });
    const parentDir = mkdtempSync(path.join(tmpdir(), "tracker-clone-"));

    const res = await api(server, "POST", "/api/github/clone", {
      nameWithOwner: "barry/widget-press",
      parentDir,
    });
    expect(res.status).toBe(201);
    expect(res.json.project.name).toBe("widget-press");
    expect(res.json.repo).toMatchObject({
      projectId: res.json.project.id,
      path: path.join(parentDir, "widget-press"),
      githubRemote: sshUrl,
      targetBranch: "trunk",
    });
    // The clone is real: a git checkout exists at the registered path.
    expect(existsSync(path.join(res.json.repo.path, ".git"))).toBe(true);
    expect(git(res.json.repo.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
  });

  test("an already-tracked remote is never cloned twice: returns the existing Project", async () => {
    const github = new FakeGitHub();
    seedAffiliated(github, "barry/fixture-app");
    const server = await bootServer(undefined, { github });
    const { project } = await seedWorkspace(server);
    const parentDir = mkdtempSync(path.join(tmpdir(), "tracker-clone-"));

    const res = await api(server, "POST", "/api/github/clone", {
      nameWithOwner: "barry/fixture-app",
      parentDir,
    });
    expect(res.status).toBe(200);
    expect(res.json.alreadyTracked).toBe(true);
    expect(res.json.project.id).toBe(project.id);
    expect(existsSync(path.join(parentDir, "fixture-app"))).toBe(false);
    const projects = (await api(server, "GET", "/api/projects")).json;
    expect(projects).toHaveLength(1);
  });

  test("an existing destination directory fails loudly with no partial Project row", async () => {
    const github = new FakeGitHub();
    seedAffiliated(github, "barry/widget-press");
    const server = await bootServer(undefined, { github });
    // The destination already exists: parent contains widget-press/.
    const parentDir = path.dirname(initScratchRepo("widget-press"));

    const res = await api(server, "POST", "/api/github/clone", {
      nameWithOwner: "barry/widget-press",
      parentDir,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("already exists");
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
  });

  test("an unknown repo or missing parent dir is a 400, not a crash", async () => {
    const github = new FakeGitHub();
    const server = await bootServer(undefined, { github });
    const missingParent = await api(server, "POST", "/api/github/clone", {
      nameWithOwner: "barry/nope",
      parentDir: path.join(tmpdir(), "does-not-exist-anywhere"),
    });
    expect(missingParent.status).toBe(400);
  });
});

describe("Home: recent projects ordering (ticket A)", () => {
  test("projects list orders by latest board activity, most recent first", async () => {
    const server = await bootServer();
    const first = (await api(server, "POST", "/api/projects", { name: "First" })).json;
    const second = (await api(server, "POST", "/api/projects", { name: "Second" })).json;
    // Freshly created, Second has the newest audit event.
    let names = (await api(server, "GET", "/api/projects")).json.map((p: any) => p.name);
    expect(names).toEqual(["Second", "First"]);
    // Board activity on First moves it back to the top.
    await api(server, "POST", "/api/tickets", {
      projectId: first.id,
      title: "wake up",
      acceptanceCriteria: [],
    });
    names = (await api(server, "GET", "/api/projects")).json.map((p: any) => p.name);
    expect(names).toEqual(["First", "Second"]);
    void second;
  });
});

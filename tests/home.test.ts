import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git, initScratchRepo } from "./git-helpers.ts";
import { api, bootServer, runCleanups, seedWorkspace, FIXTURE_REMOTE } from "./server-helpers.ts";

afterEach(runCleanups);

/** A local checkout the way Home's picker finds one: a repo with an origin. */
function initLocalRepo(name: string, remote = `git@github.com:barry/${name}.git`): string {
  const source = initScratchRepo(name);
  git(source, "remote", "add", "origin", remote);
  return source;
}

describe("Home: add a local repo", () => {
  test("registers Project + Repo with name, remote, and branch derived from the checkout", async () => {
    const server = await bootServer();
    const source = initLocalRepo("widget-press");

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(201);
    expect(res.json.project.name).toBe("widget-press");
    expect(res.json.repo).toMatchObject({
      projectId: res.json.project.id,
      // git answers --show-toplevel physically, so /var → /private/var on macOS.
      path: realpathSync(source),
      githubRemote: "git@github.com:barry/widget-press.git",
      // No origin/HEAD recorded locally — falls back to the checked-out branch.
      targetBranch: "main",
    });
  });

  test("origin's recorded HEAD wins over the checked-out branch", async () => {
    const server = await bootServer();
    const source = initLocalRepo("widget-press");
    git(source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(201);
    expect(res.json.repo.targetBranch).toBe("trunk");
  });

  test("picking a subfolder lands on the checkout root", async () => {
    const server = await bootServer();
    const source = initLocalRepo("widget-press");
    mkdirSync(path.join(source, "src", "deep"), { recursive: true });

    const res = await api(server, "POST", "/api/projects/local", {
      path: path.join(source, "src", "deep"),
    });
    expect(res.status).toBe(201);
    expect(res.json.repo.path).toBe(realpathSync(source));
  });

  test("an already-tracked checkout reopens its Project instead of duplicating it", async () => {
    const server = await bootServer();
    const { source, project } = await seedWorkspace(server);

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(200);
    expect(res.json.alreadyTracked).toBe(true);
    expect(res.json.project.id).toBe(project.id);
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(1);
  });

  test("a second checkout of a tracked remote reopens the same Project", async () => {
    const server = await bootServer();
    const { project } = await seedWorkspace(server); // Repo row on FIXTURE_REMOTE
    // Same remote, different spelling (HTTPS, cased slug) and different path.
    const other = initLocalRepo("fixture-app-elsewhere", "https://github.com/Barry/Fixture-App.git");

    const res = await api(server, "POST", "/api/projects/local", { path: other });
    expect(res.status).toBe(200);
    expect(res.json.alreadyTracked).toBe(true);
    expect(res.json.project.id).toBe(project.id);
  });

  test("a folder that is not a git repository is a 400, with no ghost Project", async () => {
    const server = await bootServer();
    const plain = path.join(tmpdir(), `tracker-not-a-repo-${process.pid}`);
    mkdirSync(plain, { recursive: true });

    const res = await api(server, "POST", "/api/projects/local", { path: plain });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("not a git repository");
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
  });

  test("a missing directory or missing path is a 400, not a crash", async () => {
    const server = await bootServer();
    const missing = await api(server, "POST", "/api/projects/local", {
      path: path.join(tmpdir(), "does-not-exist-anywhere"),
    });
    expect(missing.status).toBe(400);
    const empty = await api(server, "POST", "/api/projects/local", {});
    expect(empty.status).toBe(400);
  });

  test("a repo without an origin remote is refused loudly, with no ghost Project", async () => {
    const server = await bootServer();
    const source = initScratchRepo("orphan-app"); // no remote at all

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain('no "origin" remote');
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
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

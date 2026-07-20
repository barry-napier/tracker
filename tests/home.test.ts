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

describe("Home: recents rows", () => {
  test("carry repoPath and lastActivityAt for the list's sort/group controls", async () => {
    const server = await bootServer();
    const { source, project } = await seedWorkspace(server);

    const res = await api(server, "GET", "/api/projects");
    expect(res.status).toBe(200);
    const row = res.json.find((p: any) => p.id === project.id);
    expect(row.repoPath).toBe(source);
    // Registration itself audited (project.created, repo.created) → non-null.
    expect(typeof row.lastActivityAt).toBe("string");
  });
});

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

  test("a repo without an origin remote becomes a local-only Project (null remote)", async () => {
    const server = await bootServer();
    const source = initScratchRepo("orphan-app"); // no remote at all

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(201);
    expect(res.json.project.name).toBe("orphan-app");
    expect(res.json.repo.githubRemote).toBeNull();

    // Dedup for local-only rows is by path alone: re-adding reopens, never forks.
    const again = await api(server, "POST", "/api/projects/local", { path: source });
    expect(again.status).toBe(200);
    expect(again.json.alreadyTracked).toBe(true);
    expect(again.json.project.id).toBe(res.json.project.id);
  });
});

describe("Home: remove from recents (ticket 50)", () => {
  test("hiding forgets the list entry and deletes nothing", async () => {
    const server = await bootServer();
    const { project } = await seedWorkspace(server);
    await api(server, "POST", "/api/tickets", {
      projectId: project.id,
      title: "survives the hide",
      acceptanceCriteria: [],
    });

    const hide = await api(server, "POST", `/api/projects/${project.id}/hide`, {});
    expect(hide.status).toBe(200);
    expect(hide.json.hiddenAt).not.toBeNull();

    // Gone from recents, but the project and its history still resolve.
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
    expect((await api(server, "GET", `/api/projects/${project.id}`)).status).toBe(200);
    const audit = (await api(server, "GET", `/api/projects/${project.id}/audit`)).json;
    expect(audit.map((e: any) => e.type)).toContain("ticket.created");
    expect(audit.map((e: any) => e.type)).toContain("project.hidden");
  });

  test("re-adding a hidden project's checkout un-hides the same Project", async () => {
    const server = await bootServer();
    const { source, project } = await seedWorkspace(server);
    await api(server, "POST", `/api/projects/${project.id}/hide`, {});

    const res = await api(server, "POST", "/api/projects/local", { path: source });
    expect(res.status).toBe(200);
    expect(res.json.alreadyTracked).toBe(true);
    expect(res.json.project.id).toBe(project.id);
    expect(res.json.project.hiddenAt).toBeNull();
    // Just re-added → back in recents, at the top.
    const names = (await api(server, "GET", "/api/projects")).json.map((p: any) => p.id);
    expect(names[0]).toBe(project.id);
  });

  test("archived rows list under includeHidden=1 and unhide restores them", async () => {
    const server = await bootServer();
    const { project } = await seedWorkspace(server);
    await api(server, "POST", `/api/projects/${project.id}/hide`, {});

    // Default listing excludes; the archive listing keeps the row, flagged.
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(0);
    const all = (await api(server, "GET", "/api/projects?includeHidden=1")).json;
    expect(all).toHaveLength(1);
    expect(all[0].hiddenAt).not.toBeNull();

    const unhide = await api(server, "POST", `/api/projects/${project.id}/unhide`, {});
    expect(unhide.status).toBe(200);
    expect(unhide.json.hiddenAt).toBeNull();
    expect((await api(server, "GET", "/api/projects")).json).toHaveLength(1);
  });

  test("hiding an unknown project is a 404", async () => {
    const server = await bootServer();
    const res = await api(server, "POST", "/api/projects/999/hide", {});
    expect(res.status).toBe(404);
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

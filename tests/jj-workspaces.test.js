import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorkspace, exec, makeRepo, must, readText, removeTempDirs, run, tempDir } from "./jj-helpers.js";
import { discover } from "../mods/jj-workspaces/jj-repo.js";
import {
  checkoutPath, createWorkspace, currentName, listWorkspaces, removeWorkspace, slug, validName,
} from "../mods/jj-workspaces/workspaces.js";

afterEach(removeTempDirs);

describe("discover", () => {
  test("finds the main workspace from a subfolder", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo.main, "sub"));

    const found = await discover(exec, readText, join(repo.main, "sub"));

    expect(found).toEqual({ top: repo.main, main: repo.main, name: "main", linked: false });
  });

  test.each([["colocated", true], ["plain", false]])("finds the main workspace from a linked %s workspace", async (_, colocate) => {
    const repo = makeRepo({ colocate });
    const linked = addWorkspace(repo, "feat");

    const found = await discover(exec, readText, linked);

    expect(found).toEqual({ top: linked, main: repo.main, name: "main", linked: true });
  });

  test("returns null inside a git repo nested in a jj repo: the innermost repo wins", async () => {
    const repo = makeRepo();
    const nested = join(repo.main, "projects", "alpha");
    mkdirSync(nested, { recursive: true });
    must(["init", "-q"], nested, "git");

    expect(await discover(exec, readText, nested)).toBeNull();
  });

  test("returns null outside a jj repo", async () => {
    expect(await discover(exec, readText, tempDir())).toBeNull();
  });
});

const found = (folder) => discover(exec, readText, folder);

describe("listWorkspaces", () => {
  test("lists the main workspace first, with roots, and marks missing checkouts", async () => {
    const repo = makeRepo();
    const bugfix = addWorkspace(repo, "bugfix");
    const gone = addWorkspace(repo, "gone");
    must(["describe", "-m", "Fix work\n\nbody"], bugfix);
    rmSync(gone, { recursive: true });

    const list = await listWorkspaces(exec, await found(repo.main));

    expect(list.map(({ name, root, available, main, description }) => ({ name, root, available, main, description }))).toEqual([
      { name: "default", root: repo.main, available: true, main: true, description: "" },
      { name: "bugfix", root: bugfix, available: true, main: false, description: "Fix work" },
      { name: "gone", root: gone, available: false, main: false, description: "" },
    ]);
    expect(list[1].change).toMatch(/^[k-z]+$/);
  });

  // jj keeps the folder a workspace was made in. Some repos keep an absolute
  // path that has since moved (seen in a real repo: /Users/<old name>/...),
  // which real jj can't be made to write here, so only that answer is faked.
  test("trusts the folders it found over jj's stale records for them", async () => {
    const repo = makeRepo();
    const feat = addWorkspace(repo, "feat");
    const stale = async (command, args, cwd) =>
      command === "jj" && args.some((a) => a.startsWith("--name=")) ? { code: 0, stdout: "/Users/old/place\n", stderr: "" } : exec(command, args, cwd);

    const list = await listWorkspaces(stale, await found(feat));

    expect(list.map(({ name, root, available, main }) => ({ name, root, available, main }))).toEqual([
      { name: "default", root: repo.main, available: true, main: true },
      { name: "feat", root: feat, available: true, main: false },
    ]);
  });

  test("currentName names the workspace a checkout belongs to", async () => {
    const repo = makeRepo();
    const feat = addWorkspace(repo, "feat");

    expect(await currentName(exec, await found(feat))).toBe("feat");
  });
});

describe("names and paths", () => {
  test.each([
    ["feat", true], ["fix/login-bug_2.0", true], ["", false], ["has space", false], ["üml", false], ["a;b", false],
  ])("validName(%p) is %p", (name, ok) => {
    expect(validName(name)).toBe(ok);
  });

  test.each([
    ["Feat", "feat"], ["fix/login bug", "fix-login-bug"], ["--x--", "x"], ["../..", "workspace"],
  ])("slug(%p) is %p", (name, expected) => {
    expect(slug(name)).toBe(expected);
  });

  test("a checkout goes under ~/.herdr/jj-workspaces/<repo>/<slug>", () => {
    expect(checkoutPath("/home/me", { name: "herdr" }, "Fix/It")).toBe("/home/me/.herdr/jj-workspaces/herdr/fix-it");
  });
});

describe("createWorkspace", () => {
  test("adds a workspace at its checkout path, making the parent folders", async () => {
    const repo = makeRepo();
    const home = tempDir();

    const path = await createWorkspace(exec, await found(repo.main), home, "Feat/One");

    expect(path).toBe(join(home, ".herdr", "jj-workspaces", "main", "feat-one"));
    expect(await currentName(exec, await found(path))).toBe("Feat/One");
  });

  test("starts from a given change instead of trunk()", async () => {
    const repo = makeRepo();
    const base = must(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], repo.main);

    const path = await createWorkspace(exec, await found(repo.main), tempDir(), "from-base", base);

    expect(must(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], path)).toBe(base);
  });

  test("refuses a path that already exists and leaves it alone", async () => {
    const repo = makeRepo();
    const home = tempDir();
    const taken = join(home, ".herdr", "jj-workspaces", "main", "feat");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "keep.txt"), "keep\n");

    const attempt = createWorkspace(exec, await found(repo.main), home, "feat");

    expect(attempt).rejects.toThrow("already exists");
    await attempt.catch(() => {});
    expect(readFileSync(join(taken, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("refuses an invalid name", async () => {
    const repo = makeRepo();

    expect(createWorkspace(exec, await found(repo.main), tempDir(), "has space")).rejects.toThrow("letters, digits");
  });

  test("reports jj's error and leaves no checkout when jj refuses", async () => {
    const repo = makeRepo();
    const home = tempDir();

    const attempt = createWorkspace(exec, await found(repo.main), home, "default");

    expect(attempt).rejects.toThrow("already exists");
    await attempt.catch(() => {});
    expect(run(["-e", join(home, ".herdr", "jj-workspaces", "main", "default")], home, "test").code).not.toBe(0);
  });
});

// Herdr stops a command after 30 s unless told otherwise; adding or removing
// a checkout of a large repo can take longer.
describe("long-running commands", () => {
  const recording = (calls) => async (command, args, cwd, options) => {
    calls.push({ args, options });
    return exec(command, args, cwd);
  };

  test("workspace add and remove may run for 10 minutes", async () => {
    const repo = makeRepo();
    const calls = [];
    const path = await createWorkspace(recording(calls), await found(repo.main), tempDir(), "slow");
    await removeWorkspace(recording(calls), await found(path));

    const long = calls.filter((c) => c.args[0] === "workspace" && ["add", "remove"].includes(c.args[1]));
    expect(long.map((c) => [c.args[1], c.options?.timeout])).toEqual([["add", 600000], ["remove", 600000]]);
  });
});

describe("removeWorkspace", () => {
  test("removes a linked checkout and keeps its tracked changes in history", async () => {
    const repo = makeRepo();
    const feat = addWorkspace(repo, "feat");
    writeFileSync(join(feat, "work.txt"), "unsaved work\n");

    expect(await removeWorkspace(exec, await found(feat))).toBe("feat");

    expect(run(["-e", feat], repo.main, "test").code).not.toBe(0);
    expect(must(["workspace", "list", "-T", 'name ++ "\\n"'], repo.main)).toBe("default\n");
    expect(must(["file", "show", "-r", "all() & files(work.txt)", "work.txt"], repo.main)).toBe("unsaved work\n");
  });

  test("refuses the main workspace", async () => {
    const repo = makeRepo();

    expect(removeWorkspace(exec, await found(repo.main))).rejects.toThrow("main workspace");
  });

  test("refuses a locked Git worktree and keeps it", async () => {
    const repo = makeRepo();
    const feat = addWorkspace(repo, "feat");
    must(["worktree", "lock", "--reason", "on a USB disk", feat], repo.main, "git");

    const attempt = removeWorkspace(exec, await found(feat));

    expect(attempt).rejects.toThrow("locked (on a USB disk)");
    await attempt.catch(() => {});
    expect(run(["-d", feat], repo.main, "test").code).toBe(0);
  });
});

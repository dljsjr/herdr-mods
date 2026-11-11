import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, must, removeTempDirs, tempDir } from "./jj-helpers.js";
import { findRepos, readGit } from "../mods/jj-changes/repos.js";

afterEach(removeTempDirs);

const readText = async (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const git = (cwd, ...args) => must(["-c", "user.email=t@t", "-c", "user.name=t", ...args], cwd, "git");

function gitRepo(path, files = { "x.txt": "x\n" }) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
  git(path, "add", "-A");
  git(path, "commit", "-qm", "init");
  return path;
}

function jjRepo(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  must(["git", "init", "--no-colocate", path], join(path, ".."));
  writeFileSync(join(path, "x.txt"), "x\n");
  must(["commit", "-m", "init"], path);
  return path;
}

const found = async (start) => (await findRepos(exec, readText, start)).repos.map((r) => [r.root.slice(start.length) || ".", r.kind]);

describe("findRepos", () => {
  test("finds repos in a folder the workbench repo ignores, git and jj alike", async () => {
    const wb = gitRepo(tempDir(), { ".gitignore": "projects/\n" });
    gitRepo(join(wb, "projects", "alpha"));
    jjRepo(join(wb, "projects", "beta"));

    expect((await found(wb)).sort()).toEqual([[".", "git"], ["/projects/alpha", "git"], ["/projects/beta", "jj"]]);
  });

  test("assumes no layout: a repo deep in a folder that is not a repo is found", async () => {
    const start = tempDir();
    gitRepo(join(start, "a", "b", "c", "d", "deep"));

    expect(await found(start)).toEqual([["/a/b/c/d/deep", "git"]]);
  });

  test("does not search inside nested repos", async () => {
    const wb = tempDir();
    const alpha = gitRepo(join(wb, "alpha"));
    gitRepo(join(alpha, "vendor", "inner"));

    expect(await found(wb)).toEqual([["/alpha", "git"]]);
  });

  test("starting inside a repo, includes that repo and the innermost one wins", async () => {
    const wb = tempDir();
    must(["git", "init", "--colocate", "."], wb);
    const alpha = gitRepo(join(wb, "projects", "alpha"));
    mkdirSync(join(alpha, "src"));

    const result = await findRepos(exec, readText, join(alpha, "src"));

    expect(result.repos.map((r) => [r.root, r.kind])).toEqual([[alpha, "git"]]);
  });

  test("a colocated repo counts as jj", async () => {
    const start = tempDir();
    must(["git", "init", "--colocate", "both"], start);

    expect(await found(start)).toEqual([["/both", "jj"]]);
  });

  test("skips submodules but finds a linked git worktree", async () => {
    const start = tempDir();
    const sub = gitRepo(join(start, "..", `${start.split("/").pop()}-sub`));
    const outer = gitRepo(join(start, "outer"));
    must(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sm"], outer, "git");
    git(outer, "commit", "-qm", "sub");
    git(outer, "worktree", "add", "-q", join(start, "wt"));
    rmSync(sub, { recursive: true, force: true });

    expect((await found(start)).sort()).toEqual([["/outer", "git"], ["/wt", "git"]]);
    // Starting inside the outer repo puts the submodule in the walk's way.
    expect((await findRepos(exec, readText, outer)).repos.map((r) => r.root)).toEqual([outer]);
  });

  test("stops at the repo limit and says so", async () => {
    const start = tempDir();
    for (const n of [1, 2, 3]) gitRepo(join(start, `r${n}`));

    const result = await findRepos(exec, readText, start, { maxRepos: 2 });

    expect(result.repos).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("finds nothing in a folder with no repos", async () => {
    expect(await findRepos(exec, readText, tempDir())).toEqual({ repos: [], truncated: false });
  });
});

describe("readGit", () => {
  test("lists modified, staged, deleted and untracked files with line counts", async () => {
    const repo = gitRepo(tempDir(), { "a.txt": "a\n", "gone.txt": "g\n", "s.txt": "s\n" });
    writeFileSync(join(repo, "a.txt"), "a\nmore\n");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "s.txt"), "staged\n");
    git(repo, "add", "s.txt");
    writeFileSync(join(repo, "new.txt"), "one\ntwo\n");

    const files = await readGit(exec, readText, repo, []);

    expect(files.map(({ path, status, add, del }) => ({ path, status, add, del }))).toEqual([
      { path: "a.txt", status: "M", add: 1, del: 0 },
      { path: "gone.txt", status: "D", add: 0, del: 1 },
      { path: "new.txt", status: "A", add: 2, del: 0 },
      { path: "s.txt", status: "M", add: 1, del: 1 },
    ]);
    expect(files.find((f) => f.path === "new.txt").lines).toEqual(["@@ -0,0 +1,2 @@", "+one", "+two"]);
    expect(files.find((f) => f.path === "a.txt").lines[0]).toMatch(/^@@ /);
  });

  test("drops the entry git shows for a nested repo", async () => {
    const wb = gitRepo(tempDir());
    gitRepo(join(wb, "projects", "beta"));
    writeFileSync(join(wb, "root.txt"), "r\n");

    const files = await readGit(exec, readText, wb, [join(wb, "projects", "beta")]);

    expect(files.map((f) => f.path)).toEqual(["root.txt"]);
  });

  test("reads a repo with no commits yet", async () => {
    const repo = tempDir();
    git(repo, "init", "-q");
    writeFileSync(join(repo, "first.txt"), "1\n");

    expect((await readGit(exec, readText, repo, [])).map((f) => [f.path, f.status])).toEqual([["first.txt", "A"]]);
  });

  test("never writes under .git", async () => {
    const repo = gitRepo(tempDir());
    writeFileSync(join(repo, "x.txt"), "changed\n");
    const index = join(repo, ".git", "index"), before = statSync(index).mtimeMs;

    await readGit(exec, readText, repo, []);

    expect(statSync(index).mtimeMs).toBe(before);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
  });
});

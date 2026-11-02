import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIFF_ARGS, HEAD_ARGS, ROOT_ARGS, SNAPSHOT_ARGS, TRIGGER_ARGS,
  commitArgs, describeArgs, parseDiff, parseHead, snapshotsItself,
} from "../mods/jj-changes/jj.js";

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd, args) {
  const result = Bun.spawnSync(["jj", ...args], { cwd, env: process.env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function jj(repo, args) {
  const result = run(repo, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

// A jj repo whose @ holds `change` on top of a parent commit holding `base`.
function repoWithChange(base, change) {
  const repo = mkdtempSync(join(tmpdir(), "jj-changes-"));
  scratch.push(repo);
  jj(repo, ["git", "init"]);
  base(repo);
  jj(repo, ["commit", "-m", "base"]);
  change(repo);
  jj(repo, SNAPSHOT_ARGS);
  return repo;
}

const write = (repo, path, text) => writeFileSync(join(repo, path), text);

describe("repo setup", () => {
  test("root finds the workspace from a subfolder and fails outside a repo", () => {
    const repo = repoWithChange(() => {}, (r) => Bun.spawnSync(["mkdir", join(r, "sub")]));
    const outside = mkdtempSync(join(tmpdir(), "not-jj-"));
    scratch.push(outside);

    expect(jj(join(repo, "sub"), ROOT_ARGS).trim()).toEndWith(repo.split("/").pop());
    expect(run(outside, ROOT_ARGS).code).not.toBe(0);
  });

  test.each([
    ["true", true],
    ["false", false],
  ])("with the watchman snapshot trigger set to %s, snapshotsItself is %s", (setting, expected) => {
    const repo = repoWithChange(() => {}, () => {});
    jj(repo, ["config", "set", "--repo", "fsmonitor.watchman.register-snapshot-trigger", setting]);

    expect(snapshotsItself(run(repo, TRIGGER_ARGS))).toBe(expected);
  });

  test("snapshotsItself is false when the setting is missing", () => {
    expect(snapshotsItself({ code: 1, stdout: "", stderr: "Config error: Value not found" })).toBe(false);
  });
});

describe("parseHead", () => {
  test("reads the change id and the whole description of @", () => {
    const repo = repoWithChange(() => {}, (r) => jj(r, ["describe", "-m", "Subject line\n\nBody line one.\nBody line two."]));
    const changeId = jj(repo, ["log", "--no-graph", "-r", "@", "-T", "change_id.short()"]);

    const head = parseHead(jj(repo, HEAD_ARGS));

    expect(head).toEqual({
      change: changeId,
      conflict: false,
      description: "Subject line\n\nBody line one.\nBody line two.\n",
    });
  });

  test("reads an empty description and a conflict", () => {
    const repo = repoWithChange((r) => write(r, "c.txt", "base\n"), () => {});
    const id = (rev) => jj(repo, ["log", "--no-graph", "-r", rev, "-T", "change_id"]);
    const base = id("@-");
    write(repo, "c.txt", "left\n");
    jj(repo, ["commit", "-m", "left"]);
    const left = id("@-");
    jj(repo, ["new", base]);
    write(repo, "c.txt", "right\n");
    jj(repo, ["commit", "-m", "right"]);
    jj(repo, ["new", left, id("@-")]);

    const head = parseHead(jj(repo, HEAD_ARGS));

    expect(head.conflict).toBe(true);
    expect(head.description).toBe("");
  });
});

describe("describe and commit", () => {
  const message = "- starts like a flag\n\nand has a body";

  test("describe sets the description of @ as given", () => {
    const repo = repoWithChange(() => {}, (r) => write(r, "a.txt", "a\n"));

    jj(repo, describeArgs(message));

    expect(parseHead(jj(repo, HEAD_ARGS)).description).toBe(`${message}\n`);
  });

  test("commit describes @ and starts a new empty change on top", () => {
    const repo = repoWithChange(() => {}, (r) => write(r, "a.txt", "a\n"));

    jj(repo, commitArgs(message));

    expect(jj(repo, ["log", "--no-graph", "-r", "@-", "-T", "description"])).toBe(`${message}\n`);
    expect(parseHead(jj(repo, HEAD_ARGS)).description).toBe("");
    expect(parseDiff(jj(repo, DIFF_ARGS))).toEqual([]);
  });
});

describe("parseDiff", () => {
  test("lists added, modified and removed files with line counts", () => {
    const repo = repoWithChange(
      (r) => { write(r, "one.txt", "a\nb\n"); write(r, "gone.txt", "x\ny\n"); },
      (r) => { write(r, "one.txt", "a\nB\nc\n"); rmSync(join(r, "gone.txt")); write(r, "new.txt", "n\n"); },
    );

    const files = parseDiff(jj(repo, DIFF_ARGS));

    expect(files.map(({ path, status, add, del }) => ({ path, status, add, del }))).toEqual([
      { path: "gone.txt", status: "D", add: 0, del: 2 },
      { path: "new.txt", status: "A", add: 1, del: 0 },
      { path: "one.txt", status: "M", add: 2, del: 1 },
    ]);
  });

  test("keeps each file's lines from its first hunk header, without the end-of-file marker in the counts", () => {
    const repo = repoWithChange(
      (r) => write(r, "nn.txt", "same\nold"),
      (r) => write(r, "nn.txt", "same\nnew"),
    );

    const [file] = parseDiff(jj(repo, DIFF_ARGS));

    expect(file.lines).toEqual([
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ]);
    expect([file.add, file.del]).toEqual([1, 1]);
  });

  test("reads renames, binary changes and mode changes, which have no hunks", () => {
    const repo = repoWithChange(
      (r) => { write(r, "old.txt", "keep\n"); write(r, "b.bin", "\0one"); write(r, "s.sh", "#!/bin/sh\n"); },
      (r) => { renameSync(join(r, "old.txt"), join(r, "new.txt")); write(r, "b.bin", "\0two"); chmodSync(join(r, "s.sh"), 0o755); },
    );

    const files = parseDiff(jj(repo, DIFF_ARGS));

    expect(files.map(({ path, from, status, binary, lines }) => ({ path, from, status, binary, lines }))).toEqual([
      { path: "b.bin", from: undefined, status: "M", binary: true, lines: [] },
      { path: "new.txt", from: "old.txt", status: "R", binary: false, lines: [] },
      { path: "s.sh", from: undefined, status: "M", binary: false, lines: [] },
    ]);
  });

  test("keeps spaces, tabs and non-ASCII letters in paths", () => {
    const names = ["sp ace.txt", "ta\tb.txt", "ünï.txt"];
    const repo = repoWithChange(
      () => {},
      (r) => { for (const name of names) write(r, name, "x\n"); },
    );

    const files = parseDiff(jj(repo, DIFF_ARGS));

    expect(files.map((f) => f.path)).toEqual(names);
  });

  test("returns no files for an empty change", () => {
    const repo = repoWithChange((r) => write(r, "a.txt", "a\n"), () => {});

    expect(parseDiff(jj(repo, DIFF_ARGS))).toEqual([]);
  });
});

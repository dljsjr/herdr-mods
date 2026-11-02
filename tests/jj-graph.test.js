import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorkspace, exec, makeRepo, must, removeTempDirs } from "./jj-helpers.js";
import { LOG_ARGS, parseLog, runAction } from "../mods/jj-graph/graph.js";

afterEach(removeTempDirs);

const id = (repo, rev, template = "commit_id") => must(["log", "--no-graph", "-r", rev, "-T", template], repo);

// base, then "left" (bookmark feat) and "right" side by side, merged in @.
function branchedRepo() {
  const repo = makeRepo();
  const { main } = repo;
  const base = id(main, "@-");
  writeFileSync(join(main, "l.txt"), "l\n");
  must(["commit", "-m", "left work"], main);
  must(["bookmark", "create", "feat", "-r", "@-"], main);
  const left = id(main, "@-");
  must(["new", base, "-m", "right side"], main);
  writeFileSync(join(main, "r.txt"), "r\n");
  must(["new", left, "@", "-m", "merge both"], main);
  return repo;
}

describe("parseLog", () => {
  test("splits jj's graph from each change's fields", () => {
    const { main } = branchedRepo();

    const rows = parseLog(must(LOG_ARGS, main));
    const nodes = rows.filter((r) => r.commit);

    expect(nodes.map((n) => n.description)).toEqual(["merge both", "right side", "left work", "base", ""]);
    // jj names working copies only when a repo has more than one workspace.
    expect(nodes[0]).toMatchObject({ current: true, workspaces: [], empty: true, immutable: false, conflict: false });
    expect(nodes[0].graph.trimEnd()).toBe("@");
    expect(nodes[2].bookmarks).toEqual(["feat"]);
    expect(nodes[4]).toMatchObject({ immutable: true, current: false });
    expect(nodes[1].commit).toBe(id(main, 'description(glob:"right side*")'));
    expect(`${nodes[1].change.prefix}${nodes[1].change.rest}`).toBe(id(main, nodes[1].commit, "change_id.shortest(8)"));
    expect(rows.some((r) => !r.commit && r.graph.trim())).toBe(true);
  });

  test("lists every workspace whose working copy sits on a change", () => {
    const repo = makeRepo();
    const other = addWorkspace(repo, "other");
    must(["edit", id(repo.main, "@")], other);

    const current = parseLog(must(LOG_ARGS, repo.main)).find((r) => r.current);

    expect(current.workspaces.sort()).toEqual(["default", "other"]);
  });

  test("returns no rows for no output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("runAction", () => {
  test("edit makes a change the working copy", async () => {
    const { main } = makeRepo();
    const base = id(main, "@-");

    await runAction(exec, main, "edit", base);

    expect(id(main, "@")).toBe(base);
  });

  test("new starts a change on top of another", async () => {
    const { main } = makeRepo();
    const base = id(main, "@-");

    await runAction(exec, main, "new", base);

    expect(id(main, "@-")).toBe(base);
  });

  test("squash moves a change into its parent and keeps both descriptions", async () => {
    const { main } = makeRepo();
    writeFileSync(join(main, "b.txt"), "b\n");
    must(["commit", "-m", "second"], main);
    const second = id(main, "@-");

    await runAction(exec, main, "squash", second);

    expect(must(["file", "list", "-r", "@-"], main)).toBe("a.txt\nb.txt\n");
    expect(id(main, "@-", "description")).toBe("base\n\nsecond\n");
  });

  test("abandon drops a change", async () => {
    const { main } = makeRepo();
    writeFileSync(join(main, "b.txt"), "b\n");
    must(["commit", "-m", "second"], main);
    const second = id(main, "@-");

    await runAction(exec, main, "abandon", second);

    expect(must(["log", "--no-graph", "-r", "all()", "-T", 'description.first_line() ++ "\\n"'], main)).not.toContain("second");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorkspace, exec, makeRepo, must, removeTempDirs } from "./jj-helpers.js";
import { logArgs, parseLog, runAction } from "../mods/jj-graph/graph.js";
import { graphWidth, laneX, layout, segmentPath } from "../mods/jj-graph/lanes.js";

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
  test("reads each change, its parents and its marks from jj's JSON", () => {
    const { main } = branchedRepo();

    const commits = parseLog(must(logArgs(), main));

    expect(commits.map((c) => c.description)).toEqual(["merge both", "right side", "left work", "base", ""]);
    const [merge, right, left, base, root] = commits;
    expect(merge.parents).toEqual([left.commit, right.commit]);
    expect(merge).toMatchObject({ current: true, empty: true, immutable: false, conflict: false });
    expect(left.bookmarks).toEqual(["feat"]);
    expect(base.parents).toEqual([root.commit]);
    expect(root).toMatchObject({ immutable: true, current: false, parents: [] });
    expect(`${right.change.prefix}${right.change.rest}`).toBe(id(main, right.commit, "change_id.shortest(8)"));
  });

  test("lists every workspace whose working copy sits on a change", () => {
    const repo = makeRepo();
    const other = addWorkspace(repo, "other");
    must(["edit", id(repo.main, "@")], other);

    const current = parseLog(must(logArgs(), repo.main)).find((c) => c.current);

    expect(current.workspaces.sort()).toEqual(["default", "other"]);
  });

  test("follows the order of jj's graph, not commit time", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.main, "b.txt"), "b\n");
    must(["commit", "-m", "second"], repo.main);
    // A workspace made last holds the newest change, which a flat list puts first.
    addWorkspace(repo, "late");

    const commits = parseLog(must(logArgs(), repo.main));

    expect(commits[0].current).toBe(true);
  });

  test("keeps only a description's first line", () => {
    const { main } = makeRepo();
    must(["describe", "-m", "Subject\n\nBody"], main);

    expect(parseLog(must(logArgs(), main))[0].description).toBe("Subject");
  });

  test("shows the changes a revset names", () => {
    const { main } = branchedRepo();

    const commits = parseLog(must(logArgs("bookmarks() | root()"), main));

    expect(commits.map((c) => c.description)).toEqual(["left work", ""]);
  });

  test("shows at most the given number of changes", () => {
    const { main } = branchedRepo();

    expect(parseLog(must(logArgs("all()", 2), main))).toHaveLength(2);
  });

  test("returns no changes for no output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("layout", () => {
  const change = (commit, ...parents) => ({ commit, parents });

  test("keeps a straight history in one lane", () => {
    const { rows, width } = layout([change("c", "b"), change("b", "a"), change("a")]);

    expect(width).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[1].segments).toEqual([[0, 0, 0, 0.5, 0, false], [0, 0.5, 0, 1, 0, false]]);
    expect(rows[2].segments).toEqual([[0, 0, 0, 0.5, 0, false]]);
  });

  test("gives a merge's second parent its own lane and joins it back at the fork", () => {
    const { main } = branchedRepo();

    const { rows, width } = layout(parseLog(must(logArgs(), main)));

    expect(width).toBe(2);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0, 0]);
    expect(rows[0].segments).toContainEqual([0, 0.5, 1, 1, 1, false]);
    expect(rows[3].segments).toContainEqual([1, 0, 0, 0.5, 1, false]);
    expect(rows[4].segments.every(([from, , to]) => from === 0 && to === 0)).toBe(true);
  });

  test("places a segment in percent of the graph cell, ending on the nodes' centers", () => {
    const lanes = 3, width = graphWidth(lanes);
    const percent = (lane) => `${(laneX(lane) / width) * 100}%`;

    expect(segmentPath([0, 0, 0, 1], lanes)).toEqual({ from: [percent(0), "0%"], to: [percent(0), "100%"] });
    expect(segmentPath([1, 0.5, 2, 1], lanes)).toEqual({
      from: [percent(1), "50%"], to: [percent(2), "100%"], controls: [[percent(1), "75%"], [percent(2), "75%"]],
    });
  });

  test("ends a line at a parent jj left out with a short dashed stub", () => {
    const { rows, width } = layout([change("b", "hidden")]);

    expect(width).toBe(1);
    expect(rows[0].segments).toEqual([[0, 0.5, 0, 1, 0, true]]);
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

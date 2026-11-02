import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addWorkspace, exec, makeRepo, must, removeTempDirs } from "./jj-helpers.js";
import { defaultRevset, graphEdges, logArgs, parseLog, runAction } from "../mods/jj-graph/graph.js";
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

// A main line of changes and, in workspace "tasks", a second lineage started
// from the root commit: the shape of a repo whose task storage lives on its own
// line, with no bookmark on either head.
function twoLineages() {
  const repo = makeRepo();
  for (const step of ["m1", "m2", "m3"]) {
    writeFileSync(join(repo.main, `${step}.txt`), `${step}\n`);
    must(["commit", "-m", step], repo.main);
  }
  const tasks = addWorkspace(repo, "tasks");
  must(["new", "root()", "-m", "task storage"], tasks);
  return repo;
}

describe("graphEdges", () => {
  test("follows a hidden parent to the nearest change the revset shows", async () => {
    const { main } = twoLineages();
    const revset = "@ | root() | tasks@";
    const changes = parseLog(must(logArgs(revset), main));
    const by = (description) => changes.findIndex((c) => c.description === description);
    const root = changes.find((c) => !c.parents.length).commit;

    const edges = await graphEdges(exec, main, changes, revset);

    expect(edges[changes.findIndex((c) => c.current)]).toEqual([{ to: root, elided: true }]);
    expect(edges[by("task storage")]).toEqual([{ to: root, elided: false }]);
  });

  test("marks a hidden parent with nothing shown below it", async () => {
    const { main } = makeRepo();

    const changes = parseLog(must(logArgs("@"), main));

    expect(await graphEdges(exec, main, changes, "@")).toEqual([[{ to: null, elided: true }]]);
  });

  test("defaultRevset reads revsets.log", async () => {
    const { main } = makeRepo();
    must(["config", "set", "--repo", "revsets.log", "@ | root()"], main);

    expect(await defaultRevset(exec, main)).toBe("@ | root()");
  });
});

describe("layout", () => {
  const change = (commit, ...parents) => ({ commit, edges: parents.map((to) => ({ to, elided: false })) });

  test("keeps a straight history in one lane", () => {
    const { rows, width } = layout([change("c", "b"), change("b", "a"), change("a")]);

    expect(width).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[1].segments).toEqual([[0, 0, 0, 0.5, 0, false], [0, 0.5, 0, 1, 0, false]]);
    expect(rows[2].segments).toEqual([[0, 0, 0, 0.5, 0, false]]);
  });

  test("gives a merge's second parent its own lane and joins it back at the fork", () => {
    const { main } = branchedRepo();
    const changes = parseLog(must(logArgs(), main)).map((c) => ({ ...c, edges: c.parents.map((to) => ({ to, elided: false })) }));

    const { rows, width } = layout(changes);

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

  test("ends a line with a short dashed stub when nothing shown lies below", () => {
    const { rows, width } = layout([{ commit: "b", edges: [{ to: null, elided: true }] }]);

    expect(width).toBe(1);
    expect(rows[0].segments).toEqual([[0, 0.5, 0, 1, 0, true]]);
  });

  test("keeps a lane through elided changes, so a second lineage gets its own", async () => {
    const { main } = twoLineages();
    const revset = "@ | root() | tasks@";
    const parsed = parseLog(must(logArgs(revset), main));
    const edges = await graphEdges(exec, main, parsed, revset);
    const changes = parsed.map((c, i) => ({ ...c, edges: edges[i] }));
    const at = (pick) => changes.findIndex(pick);

    const { rows, width } = layout(changes);

    expect(width).toBe(2);
    expect(rows[at((c) => c.current)].lane).not.toBe(rows[at((c) => c.description === "task storage")].lane);
    expect(rows[at((c) => !c.parents.length)].lane).toBe(rows[at((c) => c.current)].lane);
    expect(rows[at((c) => c.current)].segments).toContainEqual([0, 0.5, 0, 1, 0, true]);
    expect(rows[at((c) => c.description === "task storage")].segments).toContainEqual([0, 0, 0, 1, 0, true]);
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

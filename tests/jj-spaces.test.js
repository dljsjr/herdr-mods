import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, makeRepo, must, removeTempDirs, tempDir } from "./jj-helpers.js";
import { readStatus } from "../mods/jj-spaces/status.js";

afterEach(removeTempDirs);

describe("readStatus", () => {
  test("an empty change without a bookmark shows as @<change id>", async () => {
    const { main } = makeRepo();
    const id = must(["log", "--no-graph", "-r", "@", "-T", "change_id.shortest(12)"], main);

    expect(await readStatus(exec, main)).toEqual({ change: `@${id}`, conflict: false, unpushed: false, ahead: 0, behind: 0, files: null });
  });

  test("counts changed files and names a bookmark with no remote as unpushed", async () => {
    const { main } = makeRepo();
    writeFileSync(join(main, "a.txt"), "changed\n");
    writeFileSync(join(main, "b.txt"), "new\n");
    must(["bookmark", "create", "feat", "-r", "@"], main);

    expect(await readStatus(exec, main)).toEqual({ change: "feat", conflict: false, unpushed: true, ahead: 0, behind: 0, files: 2 });
  });

  test("counts how far a bookmark is ahead of its tracked remote", async () => {
    const { main } = makeRepo();
    const remote = join(tempDir(), "remote.git");
    must(["init", "--bare", "-q", remote], main, "git");
    must(["git", "remote", "add", "origin", remote], main);
    must(["bookmark", "create", "main", "-r", "@-"], main);
    must(["git", "push", "--bookmark", "main"], main);
    writeFileSync(join(main, "b.txt"), "b\n");
    must(["commit", "-m", "second"], main);
    must(["bookmark", "move", "main", "--to", "@-"], main);
    must(["edit", "main"], main);

    const status = await readStatus(exec, main);

    expect([status.change, status.unpushed, status.ahead, status.behind]).toEqual(["main", false, 1, 0]);
  }, 20000);

  test("reports a conflict in @", async () => {
    const { main } = makeRepo();
    const id = (rev) => must(["log", "--no-graph", "-r", rev, "-T", "change_id"], main);
    const base = id("@-");
    writeFileSync(join(main, "a.txt"), "left\n");
    must(["commit", "-m", "left"], main);
    const left = id("@-");
    must(["new", base], main);
    writeFileSync(join(main, "a.txt"), "right\n");
    must(["commit", "-m", "right"], main);
    must(["new", left, id("@-")], main);

    expect((await readStatus(exec, main)).conflict).toBe(true);
  });
});

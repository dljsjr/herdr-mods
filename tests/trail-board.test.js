import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec, must, removeTempDirs, tempDir } from "./jj-helpers.js";
import { findProject, lanes, readTask, readTasks } from "../mods/trail-board/board.js";

afterEach(removeTempDirs);

const trail = (dir, ...args) => must(["--dir", dir, ...args], dir, "trail");

// A folder with Trail tasks: project BRD with a mix of statuses, kinds and
// priorities, one task with subtasks, and project OPS with one task.
function board() {
  const dir = tempDir();
  mkdirSync(join(dir, ".sandpiper", "tasks"), { recursive: true });
  for (const [key, name] of [["BRD", "Board"], ["OPS", "Operations"]]) {
    trail(dir, "project", "create", key, "--name", name, "--description", `${name} work`, "--when-to-read", "tests");
  }
  const create = (title, ...flags) => {
    const out = trail(dir, "task", "create", "-t", title, "--reporter", "AGENT", ...flags);
    return out.match(/Created (\S+):/)[1];
  };
  const low = create("Low task", "-p", "BRD", "--priority", "LOW");
  const bug = create("High bug", "-p", "BRD", "-k", "BUG", "--priority", "HIGH");
  const high = create("High task", "-p", "BRD", "--priority", "HIGH", "--desc", "# Plan\n\nDo **it**.");
  create("Sub one", "-p", "BRD", "-k", "SUBTASK", "--parent", high, "--priority", "MEDIUM");
  const sub2 = create("Sub two", "-p", "BRD", "-k", "SUBTASK", "--parent", high, "--priority", "MEDIUM");
  const done = create("Done task", "-p", "BRD", "--priority", "MEDIUM");
  const ops = create("Ops task", "-p", "OPS", "--priority", "MEDIUM");
  trail(dir, "task", "pickup", high);
  trail(dir, "task", "pickup", sub2);
  trail(dir, "task", "complete", sub2);
  trail(dir, "task", "complete", sub2, "--final", "--resolution", "DONE");
  trail(dir, "task", "pickup", done);
  trail(dir, "task", "complete", done);
  trail(dir, "task", "complete", done, "--final", "--resolution", "DONE");
  trail(dir, "task", "pickup", ops);
  trail(dir, "task", "complete", ops);
  return { dir, low, bug, high, done, ops };
}

describe("findProject", () => {
  test("asks trail from the folder up, so the tasks folder's name doesn't matter", async () => {
    const { dir } = board();
    mkdirSync(join(dir, "src", "deep"), { recursive: true });

    const found = await findProject(exec, join(dir, "src", "deep"));

    expect(found.root).toBe(dir);
    expect(found.projects.map((p) => p.key).sort()).toEqual(["BRD", "OPS"]);
  });

  test("returns null where trail finds no tasks", async () => {
    expect(await findProject(exec, tempDir())).toBeNull();
  });
});

describe("lanes", () => {
  test("puts open tasks in their status lane, ordered by priority, kind and key, and counts complete ones", async () => {
    const { dir, low, bug, high, ops } = board();

    const result = lanes(await readTasks(exec, dir), {});

    expect(result.lanes.map((l) => [l.status, l.cards.map((c) => c.key)])).toEqual([
      ["NOT STARTED", [bug, low]],
      ["IN PROGRESS", [high]],
      ["NEEDS REVIEW", [ops]],
    ]);
    // The completed subtask isn't shown, so it isn't counted either.
    expect(result.complete).toBe(1);
  });

  test("at equal priority, a bug comes before a task even with a later key", () => {
    const task = (key, kind) => ({ key, kind, priority: "HIGH", status: "NOT STARTED", title: key, project: "X" });

    expect(lanes([task("X-1", "TASK"), task("X-2", "BUG")]).lanes[0].cards.map((c) => c.key)).toEqual(["X-2", "X-1"]);
  });

  test("shows subtasks under their parent's count, not as cards of their own", async () => {
    const { dir, high } = board();

    const result = lanes(await readTasks(exec, dir), { subtasks: false });
    const card = result.lanes.flatMap((l) => l.cards).find((c) => c.key === high);

    expect(result.lanes[0].cards.map((c) => c.kind)).not.toContain("SUBTASK");
    expect(card.subtasks).toEqual({ done: 1, total: 2 });
    const shown = lanes(await readTasks(exec, dir), { subtasks: true }).lanes[0].cards;
    expect(shown.map((c) => c.kind)).toEqual(["BUG", "SUBTASK", "TASK"]);
  });

  test("filters by project and by text in the key or title", async () => {
    const { dir, ops, bug } = board();
    const tasks = await readTasks(exec, dir);

    expect(lanes(tasks, { project: "OPS" }).lanes.flatMap((l) => l.cards).map((c) => c.key)).toEqual([ops]);
    expect(lanes(tasks, { query: "high BUG" }).lanes.flatMap((l) => l.cards).map((c) => c.key)).toEqual([bug]);
  });
});

describe("readTask", () => {
  test("reads a task's description", async () => {
    const { dir, high } = board();

    const task = await readTask(exec, dir, high);

    expect(task.description).toContain("Do **it**.");
    expect(task.status).toBe("IN PROGRESS");
  });
});

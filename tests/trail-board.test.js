import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec, must, removeTempDirs, tempDir } from "./jj-helpers.js";
import { act, changes, createTask, findProject, keyOrder, lanes, menuItems, neighbor, readTask, readTasks, tasksDir } from "../mods/trail-board/board.js";

afterEach(removeTempDirs);

const trail = (dir, ...args) => must(["--dir", dir, ...args], dir, "trail");

// A folder with Trail tasks: project BRD with a mix of statuses, kinds and
// priorities, one task with subtasks, and project OPS with one task. The tasks
// folder isn't trail's default, so only asking trail finds it.
function board() {
  const dir = tempDir();
  trail(dir, "initialize", "--no-vcs", "--tasks-dir", "boards/work");
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
  trail(dir, "task", "update", sub2, "--status", "NEEDS REVIEW");
  trail(dir, "task", "complete", sub2, "--resolution", "DONE");
  trail(dir, "task", "pickup", done);
  trail(dir, "task", "update", done, "--status", "NEEDS REVIEW");
  trail(dir, "task", "complete", done, "--resolution", "DONE");
  trail(dir, "task", "pickup", ops);
  trail(dir, "task", "update", ops, "--status", "NEEDS REVIEW");
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

  test("finds a project with no tasks yet, where trail answers in plain text", async () => {
    const dir = tempDir();
    trail(dir, "initialize", "--no-vcs");
    trail(dir, "project", "create", "NEW", "--name", "New", "--description", "d", "--when-to-read", "t");

    const found = await findProject(exec, dir);

    expect(found).toEqual({ root: dir, projects: [] });
    expect(await readTasks(exec, dir)).toEqual([]);
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

describe("tasksDir", () => {
  test("is trail's answer to --print-tasks-dir, read from stdout", async () => {
    const fake = async (command, args) => (args.includes("--print-tasks-dir")
      ? { code: 0, stdout: "/p/boards/work\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "unexpected" });

    expect(await tasksDir(fake, "/p")).toBe("/p/boards/work");
  });

  test("is null when trail can't say: no tasks folder, or a trail without the flag", async () => {
    const failing = async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--print-tasks-dir'" });

    expect(await tasksDir(failing, "/p")).toBeNull();
  });

  test("with the trail on PATH, is the real tasks folder", async () => {
    const { dir } = board();

    expect(await tasksDir(exec, dir)).toBe(join(dir, "boards", "work"));
  });
});

describe("menuItems", () => {
  const task = (fields) => ({ key: "X-1", kind: "TASK", status: "NOT STARTED", assignee: "UNASSIGNED", priority: "MEDIUM", ...fields });
  const ops = (items) => items.map((i) => `${i.op}${i.value ? ` ${i.value}` : ""}`);

  test("offers only what would change the task", () => {
    expect(ops(menuItems(task({})))).toEqual([
      "pickup", "status IN PROGRESS", "status NEEDS REVIEW",
      "assign USER", "assign AGENT", "priority HIGH", "priority LOW",
      "subtask", "complete WONTFIX",
    ]);
  });

  test("offers DONE only from NEEDS REVIEW, as trail requires, and no subtask of a subtask", () => {
    const items = ops(menuItems(task({ kind: "SUBTASK", status: "NEEDS REVIEW", assignee: "AGENT", priority: "HIGH" })));

    expect(items).toContain("complete DONE");
    expect(items).toContain("assign UNASSIGNED");
    expect(items).not.toContain("subtask");
    expect(items).not.toContain("status NEEDS REVIEW");
  });

  test("doesn't offer pick up for a task in progress", () => {
    expect(ops(menuItems(task({ status: "IN PROGRESS" })))).not.toContain("pickup");
  });

  test("groups items so the menu can draw dividers between them", () => {
    const groups = menuItems(task({})).map((i) => i.group);

    expect([...new Set(groups)]).toEqual(["status", "assignee", "priority", "subtask", "complete"]);
  });
});

describe("act", () => {
  test("runs each menu action through trail", async () => {
    const { dir, low } = board();

    await act(exec, dir, low, { op: "pickup" });
    await act(exec, dir, low, { op: "assign", value: "USER" });
    await act(exec, dir, low, { op: "priority", value: "HIGH" });
    await act(exec, dir, low, { op: "status", value: "NEEDS REVIEW" });
    await act(exec, dir, low, { op: "complete", value: "DONE" });

    const task = await readTask(exec, dir, low);
    expect([task.status, task.resolution, task.assignee, task.priority]).toEqual(["COMPLETE", "DONE", "USER", "HIGH"]);
  });

  test("rejects with trail's own reason when trail refuses", async () => {
    const { dir, high } = board();

    await expect(act(exec, dir, high, { op: "complete", value: "DONE" })).rejects.toThrow(/NEEDS REVIEW/);
  });
});

describe("createTask", () => {
  test("creates a task with its description and assignee and returns its key", async () => {
    const { dir } = board();

    const key = await createTask(exec, dir, { project: "OPS", title: "New one", kind: "BUG", priority: "HIGH", description: "Some *text*", assignee: "AGENT" });

    const task = await readTask(exec, dir, key);
    expect([task.project, task.title, task.kind, task.priority, task.assignee, task.reporter]).toEqual(["OPS", "New one", "BUG", "HIGH", "AGENT", "USER"]);
    expect(task.description).toContain("Some *text*");
  });

  test("creates a subtask under its parent", async () => {
    const { dir, bug } = board();

    const key = await createTask(exec, dir, { project: "BRD", title: "Part", kind: "SUBTASK", parent: bug });

    const task = await readTask(exec, dir, key);
    expect([task.kind, task.parent, task.assignee]).toEqual(["SUBTASK", bug, "UNASSIGNED"]);
  });
});

describe("neighbor", () => {
  const lane = (status, ...keys) => ({ status, cards: keys.map((key) => ({ key })) });
  const board = [lane("NOT STARTED", "A-1", "A-2", "A-3"), lane("IN PROGRESS"), lane("NEEDS REVIEW", "B-1", "B-2")];

  test("starts on the first card whatever the key", () => {
    expect(neighbor(board, null, "down")).toBe("A-1");
    expect(neighbor(board, "GONE-1", "left")).toBe("A-1");
  });

  test("walks a lane, then on into the next lane with cards", () => {
    expect(neighbor(board, "A-2", "down")).toBe("A-3");
    expect(neighbor(board, "A-3", "down")).toBe("B-1");
    expect(neighbor(board, "B-1", "up")).toBe("A-3");
    expect(neighbor(board, "A-1", "up")).toBe("A-1");
    expect(neighbor(board, "B-2", "down")).toBe("B-2");
  });

  test("goes sideways to the nearest lane with cards, at the same place or the last card", () => {
    expect(neighbor(board, "A-3", "right")).toBe("B-2");
    expect(neighbor(board, "B-1", "left")).toBe("A-1");
    expect(neighbor(board, "B-1", "right")).toBe("B-1");
  });

  test("has nothing to select on an empty board", () => {
    expect(neighbor([lane("NOT STARTED")], null, "down")).toBeNull();
  });
});

describe("changes", () => {
  const task = (key, fields) => ({ key, title: `Task ${key}`, status: "NOT STARTED", assignee: "UNASSIGNED", priority: "MEDIUM", resolution: "UNRESOLVED", ...fields });

  test("says what changed, one line per change", () => {
    const before = [task("X-1"), task("X-2"), task("X-3"), task("X-4")];
    const after = [
      task("X-1", { status: "NEEDS REVIEW", assignee: "AGENT" }),
      task("X-2", { status: "COMPLETE", resolution: "WONTFIX" }),
      task("X-3", { priority: "HIGH", title: "Better name" }),
      task("X-5", { title: "Fresh" }),
    ];

    expect(changes(before, after)).toEqual([
      { key: "X-1", text: "X-1 moved to needs review" },
      { key: "X-1", text: "X-1 assigned to AGENT" },
      { key: "X-2", text: "X-2 closed as WONTFIX" },
      { key: "X-3", text: "X-3 priority high" },
      { key: "X-3", text: "X-3 renamed: Better name" },
      { key: "X-5", text: "X-5 added: Fresh" },
      { key: "X-4", text: "X-4 removed" },
    ]);
  });

  test("finds nothing when nothing a card shows changed", () => {
    expect(changes([task("X-1")], [task("X-1", { updatedAt: "later" })])).toEqual([]);
  });

  test("calls an unassigned task unassigned", () => {
    expect(changes([task("X-1", { assignee: "USER" })], [task("X-1")])).toEqual([{ key: "X-1", text: "X-1 unassigned" }]);
  });
});

describe("keyOrder", () => {
  // Herdr's script engine ignores localeCompare's { numeric: true }: compare
  // as it does, so a key order that leans on it fails here too.
  const plain = String.prototype.localeCompare;
  beforeEach(() => { String.prototype.localeCompare = function (that) { return this < that ? -1 : this > that ? 1 : 0; }; });
  afterEach(() => { String.prototype.localeCompare = plain; });

  test("orders keys by project, then by number", () => {
    const keys = ["DEMO-10", "OPS-2", "DEMO-5", "DEMO-100", "OPS-10"];

    expect(keys.map((key) => ({ key })).sort(keyOrder).map((t) => t.key)).toEqual(["DEMO-5", "DEMO-10", "DEMO-100", "OPS-2", "OPS-10"]);
  });

  test("puts a lane's cards in number order when priority and kind tie", () => {
    const task = (key) => ({ key, kind: "TASK", priority: "LOW", status: "NOT STARTED", title: key, project: "DEMO" });

    expect(lanes([task("DEMO-10"), task("DEMO-9")]).lanes[0].cards.map((c) => c.key)).toEqual(["DEMO-9", "DEMO-10"]);
  });
});

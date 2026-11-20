// Trail tasks for the trail-board panel, read through the trail CLI from PATH.
// No Herdr imports. `exec(command, args, cwd)` resolves to { code, stdout,
// stderr }.

export const STATUSES = ["NOT STARTED", "IN PROGRESS", "NEEDS REVIEW"];
export const STATUS_NAMES = { "NOT STARTED": "Not started", "IN PROGRESS": "In progress", "NEEDS REVIEW": "Needs review" };
export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];
export const ASSIGNEES = ["UNASSIGNED", "USER", "AGENT"];
const PRIORITY = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const KIND = { BUG: 0, TASK: 1, SUBTASK: 2 };

async function trail(exec, root, args) {
  const r = await exec("trail", ["--dir", root, "-f", "json", ...args], root);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `trail ${args.join(" ")} failed`);
  // With nothing to list, trail answers in plain text ("No projects found.")
  // even when asked for JSON.
  return /^\s*[[{]/.test(r.stdout) ? JSON.parse(r.stdout) : [];
}

const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";

// The folder trail keeps tasks for, as { root, projects }: the first of the
// repo containing `folder`, `folder` itself and its parents where trail
// answers. trail decides, because its config names the tasks folder; null
// where no folder has tasks.
export async function findProject(exec, folder) {
  const candidates = [];
  const top = await exec("git", ["rev-parse", "--show-toplevel"], folder);
  const jj = await exec("jj", ["--no-pager", "--ignore-working-copy", "workspace", "root"], folder);
  for (const r of [jj, top]) if (r.code === 0) candidates.push(r.stdout.trim());
  for (let dir = folder; ; dir = parentOf(dir)) {
    candidates.push(dir);
    if (dir === "/") break;
  }
  for (const root of [...new Set(candidates)]) {
    try { return { root, projects: await trail(exec, root, ["project", "list"]) }; } catch {}
  }
  return null;
}

// The absolute path of the project's tasks folder, from trail itself, since
// its config can name any folder. null when there is none, or when the trail
// on PATH predates --print-tasks-dir.
export async function tasksDir(exec, root) {
  const r = await exec("trail", ["--dir", root, "--print-tasks-dir"], root);
  const path = r.stdout.trim();
  return r.code === 0 && path ? path : null;
}

export const readTasks = (exec, root) => trail(exec, root, ["task", "list"]);

export async function readTask(exec, root, key) {
  const task = await trail(exec, root, ["task", "show", key]);
  return Array.isArray(task) ? task[0] : task;
}

// Tasks by key: project, then number. Herdr's script engine ignores
// localeCompare's numeric option, so the number is compared as a number.
export function keyOrder(a, b) {
  const [, pa, na] = /^(.*)-(\d+)$/.exec(a.key) ?? [, a.key, "0"];
  const [, pb, nb] = /^(.*)-(\d+)$/.exec(b.key) ?? [, b.key, "0"];
  return pa < pb ? -1 : pa > pb ? 1 : Number(na) - Number(nb);
}

const byRank = (a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9)
  || (KIND[a.kind] ?? 9) - (KIND[b.kind] ?? 9)
  || keyOrder(a, b);

// The board: { lanes: [{ status, cards }], complete } for the open statuses,
// each card a task plus { subtasks: { done, total } } when it has any.
// `project` keeps one project's tasks; `query` keeps tasks whose key or title
// holds every word; subtasks show as cards only with `subtasks`.
export function lanes(tasks, { project = null, query = "", subtasks = false } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const children = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    const c = children.get(t.parent) ?? { done: 0, total: 0 };
    c.total++;
    if (t.status === "COMPLETE") c.done++;
    children.set(t.parent, c);
  }
  const shown = tasks.filter((t) => (!project || t.project === project)
    && (subtasks || t.kind !== "SUBTASK")
    && words.every((w) => `${t.key} ${t.title}`.toLowerCase().includes(w)));
  return {
    lanes: STATUSES.map((status) => ({
      status,
      cards: shown.filter((t) => t.status === status).sort(byRank).map((t) => ({ ...t, subtasks: children.get(t.key) ?? null })),
    })),
    complete: shown.filter((t) => t.status === "COMPLETE").length,
  };
}

// A card's menu: what can be done to `task` from where it is, as { label, op,
// value, group }, for act() (op "subtask" asks for a new subtask instead).
// Items that would change nothing are left out, and DONE needs NEEDS REVIEW
// first, as trail requires.
export function menuItems(task) {
  const items = [];
  const add = (group, label, op, value) => items.push({ group, label, op, value });
  if (task.status !== "IN PROGRESS") add("status", "Pick up", "pickup");
  for (const s of STATUSES) if (s !== task.status) add("status", `Move to ${STATUS_NAMES[s].toLowerCase()}`, "status", s);
  for (const a of ["USER", "AGENT", "UNASSIGNED"]) if (a !== task.assignee) add("assignee", a === "UNASSIGNED" ? "Unassign" : `Assign to ${a}`, "assign", a);
  for (const p of PRIORITIES) if (p !== task.priority) add("priority", `Priority ${p.toLowerCase()}`, "priority", p);
  if (task.kind !== "SUBTASK") add("subtask", "Add subtask…", "subtask");
  if (task.status === "NEEDS REVIEW") add("complete", "Complete as done", "complete", "DONE");
  add("complete", "Close as won't fix", "complete", "WONTFIX");
  return items;
}

// One change to task `key` through trail. `value` is the status, assignee,
// priority or resolution. Rejects with trail's reason when it refuses.
export async function act(exec, root, key, { op, value }) {
  const args = {
    pickup: ["task", "pickup", key],
    status: ["task", "update", key, "--status", value],
    assign: ["task", "update", key, "--assignee", value],
    priority: ["task", "update", key, "--priority", value],
    complete: ["task", "complete", key, "--resolution", value],
  }[op];
  if (!args) throw new Error(`Unknown task action: ${op}`);
  await trail(exec, root, args);
}

// Creates a task reported by USER and returns its key. trail task create
// can't set an assignee, so one other than UNASSIGNED is a second command.
export async function createTask(exec, root, { project, title, kind = "TASK", priority = "MEDIUM", parent = null, description = "", assignee = "UNASSIGNED" }) {
  const args = ["task", "create", "-p", project, "-t", title, "-k", kind, "--priority", priority, "--reporter", "USER"];
  if (parent) args.push("--parent", parent);
  if (description.trim()) args.push("--desc", description.trim());
  const [task] = await trail(exec, root, args);
  if (assignee !== "UNASSIGNED") await act(exec, root, task.key, { op: "assign", value: assignee });
  return task.key;
}

// The card a keyboard move from `key` selects in `lanes` (the board's lanes,
// with a folded lane's cards left out): up and down walk a lane and carry on
// into the next lane with cards; left and right go to the nearest lane with
// cards, at the same place or its last card. With nothing selected, the
// first card; null on an empty board.
export function neighbor(lanes, key, direction) {
  const full = lanes.filter((l) => l.cards.length);
  if (!full.length) return null;
  const li = full.findIndex((l) => l.cards.some((c) => c.key === key));
  if (li < 0) return full[0].cards[0].key;
  const cards = full[li].cards, ci = cards.findIndex((c) => c.key === key);
  if (direction === "up") return ci > 0 ? cards[ci - 1].key : li > 0 ? full[li - 1].cards.at(-1).key : key;
  if (direction === "down") return ci < cards.length - 1 ? cards[ci + 1].key : li < full.length - 1 ? full[li + 1].cards[0].key : key;
  const next = full[li + (direction === "left" ? -1 : 1)];
  return next ? next.cards[Math.min(ci, next.cards.length - 1)].key : key;
}

// What changed between two reads of a board, for a notice: { key, text } per
// change to what a card shows (status, assignee, priority, title), then
// tasks added and removed.
export function changes(before, after) {
  const old = new Map(before.map((t) => [t.key, t]));
  const out = [];
  const say = (key, text) => out.push({ key, text });
  for (const t of after) {
    const was = old.get(t.key);
    if (!was) continue;
    if (was.status !== t.status) say(t.key, t.status === "COMPLETE" ? `${t.key} closed as ${t.resolution}` : `${t.key} moved to ${(STATUS_NAMES[t.status] ?? t.status).toLowerCase()}`);
    if (was.assignee !== t.assignee) say(t.key, t.assignee === "UNASSIGNED" ? `${t.key} unassigned` : `${t.key} assigned to ${t.assignee}`);
    if (was.priority !== t.priority) say(t.key, `${t.key} priority ${t.priority.toLowerCase()}`);
    if (was.title !== t.title) say(t.key, `${t.key} renamed: ${t.title}`);
  }
  for (const t of after) if (!old.has(t.key)) say(t.key, `${t.key} added: ${t.title}`);
  const now = new Set(after.map((t) => t.key));
  for (const t of before) if (!now.has(t.key)) say(t.key, `${t.key} removed`);
  return out;
}

// Trail tasks for the trail-board panel, read through the trail CLI from PATH.
// No Herdr imports. `exec(command, args, cwd)` resolves to { code, stdout,
// stderr }.

export const STATUSES = ["NOT STARTED", "IN PROGRESS", "NEEDS REVIEW"];
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

const byRank = (a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9)
  || (KIND[a.kind] ?? 9) - (KIND[b.kind] ?? 9)
  || a.key.localeCompare(b.key, undefined, { numeric: true });

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

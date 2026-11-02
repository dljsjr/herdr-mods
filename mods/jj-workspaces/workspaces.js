// jj workspace operations for the jj-workspaces dialog, following the old
// herdr-jj plugin. `exec(command, args, cwd)` resolves to { code, stdout,
// stderr }; `repo` comes from discover() in jj-repo.js.
import { READ } from "./jj-repo.js";

const SEP = "\x1f";
const LIST_TEMPLATE = `name ++ "\\x1f" ++ target.change_id().shortest(12) ++ "\\x1f" ++ target.description().first_line() ++ "\\n"`;

async function jj(exec, args, cwd) {
  const r = await exec("jj", args, cwd);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `jj ${args.join(" ")} failed`);
  return r.stdout;
}

const exists = async (exec, path, cwd, flag = "-e") => (await exec("test", [flag, path], cwd)).code === 0;

async function rootOf(exec, repo, name) {
  const r = await exec("jj", [...READ, "workspace", "root", `--name=${name}`], repo.main);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Every workspace of the repo, the main one first:
// { name, change, description, root, available, main }.
export async function listWorkspaces(exec, repo) {
  const out = [];
  for (const line of (await jj(exec, [...READ, "workspace", "list", "-T", LIST_TEMPLATE], repo.main)).split("\n")) {
    if (!line) continue;
    const [name, change, description] = line.split(SEP);
    const root = await rootOf(exec, repo, name);
    out.push({ name, change, description, root, available: Boolean(root) && await exists(exec, root, repo.main, "-d"), main: root === repo.main });
  }
  return out.sort((a, b) => b.main - a.main || a.name.localeCompare(b.name));
}

// The name of the workspace checked out at repo.top.
export async function currentName(exec, repo) {
  const name = (await jj(exec, [...READ, "workspace", "list", "-T", 'if(target.current_working_copy(), name ++ "\\n", "")'], repo.top)).trim();
  if (!name) throw new Error("jj didn't say which workspace this is.");
  return name;
}

export const validName = (name) => /^[A-Za-z0-9._/-]+$/.test(name);

export function slug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "workspace";
}

export const checkoutPath = (home, repo, name) => `${home}/.herdr/jj-workspaces/${repo.name}/${slug(name)}`;

// Adds workspace `name` at its checkout path, starting from trunk(). Returns the path.
export async function createWorkspace(exec, repo, home, name) {
  if (!validName(name)) throw new Error("Use letters, digits, '.', '_', '-' and '/' in a workspace name.");
  const path = checkoutPath(home, repo, name);
  if (await exists(exec, path, repo.top)) throw new Error(`${path} already exists.`);
  const parent = path.slice(0, path.lastIndexOf("/"));
  const made = await exec("mkdir", ["-p", parent], repo.top);
  if (made.code !== 0) throw new Error(made.stderr.trim() || `Couldn't make ${parent}.`);
  await jj(exec, ["workspace", "add", `--name=${name}`, "--revision=trunk()", path], repo.top);
  return path;
}

// Removes the workspace checked out at repo.top. jj snapshots it first, so its
// tracked changes stay in history; files jj doesn't track go with the folder.
// Returns its name.
export async function removeWorkspace(exec, repo) {
  if (!repo.linked) throw new Error("This is the repo's main workspace: jj keeps the repo there.");
  const name = await currentName(exec, repo);
  if ((await rootOf(exec, repo, name)) !== repo.top) throw new Error(`jj's workspace ${name} isn't this folder.`);
  await refuseLocked(exec, repo);
  await jj(exec, ["workspace", "remove", "--", name], repo.main);
  return name;
}

// Git won't prune or remove a locked worktree's entry. jj would delete the
// checkout and leave that entry behind, which blocks a new workspace at the
// same path, so refuse as `git worktree remove` does.
async function refuseLocked(exec, repo) {
  if (!(await exists(exec, `${repo.main}/.git`, repo.main, "-d"))) return;
  const r = await exec("git", ["worktree", "list", "--porcelain", "-z"], repo.main);
  if (r.code !== 0) throw new Error(`Couldn't check whether Git has this worktree locked: ${(r.stderr || r.stdout).trim()}`);
  const reason = lockReason(r.stdout, repo.top);
  if (reason !== null) throw new Error(`Git has this worktree locked${reason ? ` (${reason})` : ""}. Run git worktree unlock ${repo.top} first.`);
}

// From `git worktree list --porcelain -z`: the lock reason of the entry at
// `path` ("" for a lock without one), or null when it isn't locked.
function lockReason(listing, path) {
  let entry = null;
  for (const field of listing.split("\0")) {
    if (field.startsWith("worktree ")) entry = field.slice(9) === path ? "this" : "other";
    else if (entry === "this" && (field === "locked" || field.startsWith("locked "))) return field.slice(7);
  }
  return null;
}

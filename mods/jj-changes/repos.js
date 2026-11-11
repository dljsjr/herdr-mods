// Finding the repos below a folder, and reading a git repo's changes, for the
// jj-changes panel. No Herdr imports. `exec(command, args, cwd)` resolves to
// { code, stdout, stderr }; `readText(path)` to a file's text, or null.
import { parseDiff } from "./jj.js";

const JJ_READ = ["--no-pager", "--color=never", "--ignore-working-copy"];
// Reads write nothing under .git (no index refresh or lock, no fsmonitor
// cookie), so a folder watch doesn't see the panel's own reads.
const GIT_READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CHUNK = 400; // folders per find call, well under the argument limit

const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

// The innermost repo containing `folder`, asking both git and jj: inside a git
// repo nested in a jj repo, jj names the outer one, and the other way round.
async function containing(exec, folder) {
  const [g, j] = await Promise.all([
    exec("git", ["rev-parse", "--show-toplevel"], folder),
    exec("jj", [...JJ_READ, "workspace", "root"], folder),
  ]);
  const roots = [g.code === 0 && g.stdout.trim(), j.code === 0 && j.stdout.trim()].filter(Boolean);
  return roots.sort((a, b) => b.length - a.length)[0] ?? null;
}

// git or jj for a folder holding a .git and/or .jj; null for a submodule,
// whose files belong to the repo that contains it.
async function kindOf(readText, root, names) {
  if (names.has(".jj")) return "jj";
  const dotGit = await readText(`${root}/.git`).catch(() => null);
  return typeof dotGit === "string" && /^gitdir:.*\/modules\//m.test(dotGit) ? null : "git";
}

// The repos the panel shows for `start`: the innermost repo containing it,
// then every repo below it, found by walking the folders one level at a time.
// Ignore rules play no part, so repos in ignored folders are found too. The
// walk doesn't go inside a nested repo: repos within repos aren't shown, and
// their build output and dependencies aren't walked. Returns { repos: [{ root,
// kind }], truncated }, where truncated says a limit stopped the walk.
export async function findRepos(exec, readText, start, { maxRepos = 50, maxFolders = 50000 } = {}) {
  const repos = [];
  const top = await containing(exec, start);
  if (top) {
    const hasJj = (await exec("test", ["-d", `${top}/.jj`], top)).code === 0;
    repos.push({ root: top, kind: hasJj ? "jj" : "git" });
  }
  let frontier = [start], folders = 0, truncated = false;
  while (frontier.length && !truncated) {
    const children = new Map(); // folder -> names of its subfolders and .git/.jj
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const r = await exec("find", [...frontier.slice(i, i + CHUNK), "-mindepth", "1", "-maxdepth", "1", "(", "-type", "d", "-o", "-name", ".git", "-o", "-name", ".jj", ")", "-print0"], start);
      // An unreadable folder makes find fail but still lists the rest.
      for (const path of r.stdout.split("\0").filter(Boolean)) {
        const parent = parentOf(path);
        if (!children.has(parent)) children.set(parent, new Set());
        children.get(parent).add(path.slice(parent.length + 1));
      }
    }
    const next = [];
    for (const parent of [...children.keys()].sort()) {
      const names = children.get(parent);
      const nested = parent !== start && (names.has(".git") || names.has(".jj"));
      if (nested) {
        const kind = await kindOf(readText, parent, names);
        if (kind && !repos.some((r) => r.root === parent)) repos.push({ root: parent, kind });
        if (repos.length >= maxRepos) { truncated = true; break; }
        continue;
      }
      for (const name of names) if (name !== ".git" && name !== ".jj") next.push(`${parent}/${name}`);
    }
    folders += next.length;
    if (folders > maxFolders) truncated = true;
    frontier = next;
  }
  return { repos, truncated };
}

// A git repo's changes against HEAD (staged and not), as jj.js's parseDiff
// returns them, plus untracked files read whole. `nested` lists repo roots
// inside this one, whose single "??" entry would hide that repo's own files.
export async function readGit(exec, readText, root, nested) {
  const git = async (args, allowFail = false) => {
    const r = await exec("git", [...GIT_READ, ...args], root);
    if (r.code !== 0 && !allowFail) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r;
  };
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], true);
  const base = head.code === 0 ? "HEAD" : (await git(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
  const diff = await git(["diff", base, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]);
  const parsed = new Map(parseDiff(diff.stdout).map((f) => [f.path, f]));
  const files = [];
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    const xy = entry.slice(0, 2), path = entry.slice(3).replace(/\/$/, "");
    if (nested.some((n) => inside(`${root}/${path}`, n))) continue;
    const fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const status = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    if (!fresh) {
      const f = parsed.get(path) ?? { add: 0, del: 0, binary: false, lines: [] };
      files.push({ ...f, path, status });
      continue;
    }
    const text = await readText(`${root}/${path}`).catch(() => null);
    const binary = typeof text === "string" && text.includes("\0");
    const body = typeof text === "string" && !binary ? text.replace(/\n$/, "").split("\n") : [];
    const add = typeof text === "string" && !binary ? body.length - Number(text === "") : 0;
    files.push({ path, status, add, del: 0, binary, lines: add ? [`@@ -0,0 +1,${add} @@`, ...body.slice(0, 1500).map((l) => `+${l}`)] : [] });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const gitCommitSteps = (message) => [["add", "-A"], ["commit", `--message=${message}`]];

// The Changes list's rows. Flat: { type: "file", file, text } per file, text
// being its path from the focused folder. Grouped: a { type: "repo", root,
// label, kind, head, count, add, del, collapsed } header per repo with changes,
// the repos containing `start` first, then by label, each followed by its
// files (unless collapsed), text being the path from the repo's root.
export function listRows(files, repos, { grouped, start = "", labelOf = (r) => r.root, collapsed = new Set() } = {}) {
  if (!grouped) return files.map((file) => ({ type: "file", file, text: file.display }));
  const contains = (repo) => start === repo.root || start.startsWith(`${repo.root}/`);
  const order = repos.filter((r) => files.some((f) => f.repo === r.root))
    .map((repo) => ({ repo, label: labelOf(repo) }))
    .sort((a, b) => contains(b.repo) - contains(a.repo) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const rows = [];
  for (const { repo, label } of order) {
    const mine = files.filter((f) => f.repo === repo.root).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const shut = collapsed.has(repo.root);
    rows.push({
      type: "repo", root: repo.root, label, kind: repo.kind, head: repo.head, collapsed: shut,
      count: mine.length, add: mine.reduce((n, f) => n + f.add, 0), del: mine.reduce((n, f) => n + f.del, 0),
    });
    if (!shut) for (const file of mine) rows.push({ type: "file", file, text: file.path });
  }
  return rows;
}

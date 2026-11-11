// Finding a folder's jj workspace and the repo's main workspace. Shared by the
// jj mods: each mod keeps its own copy, because a mod can't import from
// outside its folder. tests/jj-workspaces.test.js keeps the copies identical.
//
// `exec(command, args, cwd)` resolves to { code, stdout, stderr };
// `readText(path)` resolves to a file's text, or null or a rejection when
// there is no such file.

// Reads that never snapshot, so they never write under .jj.
export const READ = ["--no-pager", "--color=never", "--ignore-working-copy"];

// The workspace a folder is in: { top, main, name, linked }, where `main` is
// the workspace holding the repo, `name` its folder name, and `linked` says
// `top` is another workspace. null outside jj, and inside a git repo nested in
// a jj workspace: jj names the outer workspace there, but the innermost repo is
// the one the folder belongs to.
export async function discover(exec, readText, folder) {
  const [root, git] = await Promise.all([
    exec("jj", [...READ, "workspace", "root"], folder),
    exec("git", ["rev-parse", "--show-toplevel"], folder),
  ]);
  if (root.code !== 0) return null;
  const top = root.stdout.trim();
  if (git.code === 0 && git.stdout.trim().length > top.length) return null;
  // The main workspace keeps the repo in .jj/repo; another one has a file
  // there with the repo's path, relative to its own .jj.
  let pointer = null;
  try { pointer = await readText(`${top}/.jj/repo`); } catch {}
  const main = pointer?.trim() ? mainFromPointer(top, pointer.trim()) : top;
  return { top, main, name: main.split("/").pop(), linked: main !== top };
}

function mainFromPointer(top, pointer) {
  const parts = [];
  for (const part of (pointer.startsWith("/") ? pointer : `${top}/.jj/${pointer}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`.replace(/\/\.jj\/repo$/, "");
}

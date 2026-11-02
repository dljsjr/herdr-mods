// jj commands and output parsing for the jj-changes panel. No Herdr imports,
// so tests can run it against real jj repos.

const READ = ["--no-pager", "--color=never", "--ignore-working-copy"];

export const ROOT_ARGS = [...READ, "root"];

// Reads skip the snapshot, so they never write under .jj. They stay current
// only where watchman snapshots on file changes; elsewhere, snapshot first.
export const TRIGGER_ARGS = ["config", "get", "fsmonitor.watchman.register-snapshot-trigger"];
export const SNAPSHOT_ARGS = ["util", "snapshot"];
export const snapshotsItself = (result) => result.code === 0 && result.stdout.trim() === "true";

// The change in @ against its parent, in Git's diff format.
export const DIFF_ARGS = [...READ, "diff", "--git"];

export const HEAD_ARGS = [
  ...READ, "log", "--no-graph", "-r", "@",
  "-T", 'change_id.short() ++ "\\0" ++ if(conflict, "conflict") ++ "\\0" ++ description',
];

export function parseHead(text) {
  const [change, conflict, ...description] = text.split("\0");
  return { change, conflict: conflict === "conflict", description: description.join("\0") };
}

// Splits `jj diff --git` output into files: status A, M, D or R (with `from`),
// added and removed line counts, whether it is binary, and the lines from the
// first hunk header on.
export function parseDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: headerPath(line), status: "M", add: 0, del: 0, binary: false, lines: [] };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (file.lines.length || line.startsWith("@@")) {
      file.lines.push(line);
      if (line[0] === "+") file.add++;
      else if (line[0] === "-") file.del++;
    } else if (line.startsWith("new file mode")) {
      file.status = "A";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "D";
    } else if (line.startsWith("rename from ")) {
      file.status = "R";
      file.from = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ")) {
      file.binary = true;
    }
  }
  for (const f of files) {
    while (f.lines.length && f.lines[f.lines.length - 1] === "") f.lines.pop();
  }
  return files;
}

// "diff --git a/<path> b/<path>": jj doesn't quote paths, and both halves are
// the same path unless the file was renamed.
function headerPath(line) {
  const pair = line.slice("diff --git ".length);
  return pair.slice(2, 2 + (pair.length - 5) / 2);
}

// The = form keeps a message that starts with "-" from being read as a flag.
export const describeArgs = (message) => ["describe", `--message=${message}`];
export const commitArgs = (message) => ["commit", `--message=${message}`];

// jj log for the jj-graph panel: jj draws the graph (with the person's
// ui.graph.style and revsets.log), and a separator marks where each change's
// fields start, so the panel only styles them. No Herdr imports.
import { READ } from "./jj-repo.js";

const SEP = "\x1f";
const FIELDS = [
  "change_id.shortest(8).prefix()", "change_id.shortest(8).rest()", "commit_id",
  'local_bookmarks.map(|b| b.name()).join(" ")', "working_copies",
  'if(current_working_copy, "1")', 'if(empty, "1")', 'if(conflict, "1")', 'if(immutable, "1")',
  "description.first_line()",
];

export const LOG_ARGS = [...READ, "log", "-T", `"\\x1f" ++ ${FIELDS.join(' ++ "\\x1f" ++ ')} ++ "\\n"`];

const words = (text) => text.split(" ").filter(Boolean);

// One row per output line: { graph } for lines that are only graph, or
// { graph, change: { prefix, rest }, commit, bookmarks, workspaces, current,
// empty, conflict, immutable, description } for a change.
export function parseLog(text) {
  if (!text) return [];
  return text.replace(/\n$/, "").split("\n").map((line) => {
    const at = line.indexOf(SEP);
    if (at < 0) return { graph: line };
    const [prefix, rest, commit, bookmarks, workspaces, current, empty, conflict, immutable, description] = line.slice(at + 1).split(SEP);
    return {
      graph: line.slice(0, at), change: { prefix, rest }, commit,
      bookmarks: words(bookmarks), workspaces: words(workspaces).map((w) => w.replace(/@$/, "")),
      current: current === "1", empty: empty === "1", conflict: conflict === "1", immutable: immutable === "1",
      description,
    };
  });
}

async function jj(exec, args, cwd) {
  const r = await exec("jj", args, cwd);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `jj ${args[0]} failed`);
  return r.stdout;
}

const description = async (exec, cwd, rev) => (await jj(exec, [...READ, "log", "--no-graph", "-r", rev, "-T", "description"], cwd)).trimEnd();

// Runs edit, new, squash (into the parent) or abandon on a change, named by
// commit id because a divergent change id names several commits.
export async function runAction(exec, cwd, action, commit) {
  if (action === "squash") {
    // With two descriptions, jj squash opens an editor to combine them, which
    // would hang the panel; combine them the way that editor starts out.
    const message = [await description(exec, cwd, `${commit}-`), await description(exec, cwd, commit)].filter(Boolean).join("\n\n");
    return jj(exec, ["squash", "--revision", commit, `--message=${message}`], cwd);
  }
  if (!["edit", "new", "abandon"].includes(action)) throw new Error(`Unknown action ${action}`);
  return jj(exec, [action, commit], cwd);
}

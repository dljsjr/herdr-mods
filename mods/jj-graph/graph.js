// jj log for the jj-graph panel: one JSON object per change, json(self) plus
// what the panel marks, so lanes.js can lay the graph out and the panel can
// draw it. No Herdr imports.
//
// jj still draws its graph here, and only the JSON on each change's line is
// read: with --no-graph jj lists changes by commit time, while its graph
// keeps branches together and @ on top.
import { READ } from "./jj-repo.js";

const FIELDS = [
  ["self", "self"],
  ["prefix", "change_id.shortest(8).prefix()"],
  ["rest", "change_id.shortest(8).rest()"],
  ["bookmarks", "local_bookmarks.map(|b| b.name())"],
  ["workspaces", "working_copies.map(|w| w.name())"],
  ["current", "current_working_copy"],
  ["empty", "empty"],
  ["conflict", "conflict"],
  ["immutable", "immutable"],
];

const START = '{"self":';

const TEMPLATE = FIELDS.map(([key, expr], i) => `"${i ? "," : "{"}\\"${key}\\":" ++ json(${expr})`).join(" ++ ") + ' ++ "}\\n"';

// At most `limit` changes in `revset`, or in the person's revsets.log when
// it's empty. The limit keeps a wide revset under exec's 8 MiB.
export const LIMIT = 500;
export const logArgs = (revset = "", limit = LIMIT) => [
  ...READ, "log", ...(revset ? [`--revisions=${revset}`] : []), `--limit=${limit}`, "-T", TEMPLATE,
];

// The changes in jj's order (every child before its parents): { commit,
// parents, change: { prefix, rest }, description (first line), bookmarks,
// workspaces, current, empty, conflict, immutable }.
export function parseLog(text) {
  return text.split("\n").filter((line) => line.includes(START)).map((line) => {
    // Graph characters never include "{", and JSON escapes any quote in a description.
    const { self, prefix, rest, ...marks } = JSON.parse(line.slice(line.indexOf(START)));
    return { commit: self.commit_id, parents: self.parents, change: { prefix, rest }, description: self.description.split("\n")[0], ...marks };
  });
}

// The revset jj log shows when given none.
export async function defaultRevset(exec, cwd) {
  const r = await exec("jj", ["config", "get", "revsets.log"], cwd);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Asking jj about more hidden parents than this would slow every refresh;
// past it, they end in stubs.
const MAX_HIDDEN = 100;

// The lines to draw from each change, as [{ to, elided }]: to each parent the
// log shows, and for a parent the revset hides, to the nearest shown changes
// it descends from. jj draws those as one line through "(elided revisions)",
// and they are what keep separate lineages in separate lanes. A hidden parent
// with nothing shown below it gets { to: null }, a stub.
export async function graphEdges(exec, cwd, changes, revset) {
  const shown = new Set(changes.map((c) => c.commit));
  const hidden = [...new Set(changes.flatMap((c) => c.parents.filter((p) => !shown.has(p))))];
  const below = new Map(revset && hidden.length <= MAX_HIDDEN ? await Promise.all(hidden.map(async (parent) => {
    const r = await exec("jj", [...READ, "log", "--no-graph", `--revisions=heads(::${parent} & (${revset}))`, "-T", 'commit_id ++ "\\n"'], cwd);
    return [parent, r.code === 0 ? r.stdout.split("\n").filter((id) => shown.has(id)) : []];
  })) : []);
  return changes.map((c) => {
    const edges = [];
    for (const parent of c.parents) {
      if (shown.has(parent)) edges.push({ to: parent, elided: false });
      else {
        const found = below.get(parent) ?? [];
        if (!found.length) edges.push({ to: null, elided: true });
        for (const to of found) if (!edges.some((e) => e.to === to)) edges.push({ to, elided: true });
      }
    }
    return edges;
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

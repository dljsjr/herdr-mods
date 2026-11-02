// A jj workspace's status for the sidebar, as the old herdr-jj plugin
// reported it. `exec(command, args, cwd)` resolves to { code, stdout, stderr }.
import { READ } from "./jj-repo.js";

const SEP = "\x1f";
const STATUS = [
  'if(conflict, "1", "")', 'if(empty, "1", "")', "change_id.shortest(12)",
  "self.diff().files().len()", 'local_bookmarks.map(|b| b.name()).join(" ")',
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';
// jj counts tracking distance from the remote ref's side, so behind comes
// first: it is how far the local bookmark is ahead.
const TRACKING = 'if(self.remote() && self.remote() != "git", self.tracking_behind_count().lower() ++ "\\x1f" ++ self.tracking_ahead_count().lower() ++ "\\n")';

// { change, conflict, unpushed, ahead, behind, files }: `change` is @'s local
// bookmarks or @<change id>; `unpushed` says its first bookmark tracks no
// remote; ahead/behind are the most against any remote it tracks; `files` is
// how many files @ changes, null when it is empty.
export async function readStatus(exec, top) {
  const r = await exec("jj", [...READ, "log", "--no-graph", "-r", "@", "-T", STATUS], top);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "jj log failed");
  const [conflict, empty, change, files, bookmarks] = r.stdout.replace(/\n$/, "").split(SEP);
  const names = bookmarks.split(" ").filter(Boolean);
  let ahead = 0, behind = 0, unpushed = false;
  if (names.length) {
    const t = await exec("jj", [...READ, "bookmark", "list", "--tracked", "-T", TRACKING, `exact:${names[0]}`], top);
    if (t.code === 0) {
      const rows = t.stdout.split("\n").filter(Boolean).map((line) => line.split(SEP).map(Number));
      unpushed = rows.length === 0;
      for (const [a, b] of rows) { ahead = Math.max(ahead, a); behind = Math.max(behind, b); }
    }
  }
  return { change: names.length ? names.join(" ") : `@${change}`, conflict: conflict === "1", unpushed, ahead, behind, files: empty === "1" ? null : Number(files) };
}

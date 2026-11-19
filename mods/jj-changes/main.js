// jj-changes: Herdr's Changes panel for jj and git, across every repo below
// the focused folder.
//
// Derived from defaults/mods/changes/main.js in herdr-app 0.1.12, with its
// fixes through 0.1.16 merged in (https://github.com/herdrdev/herdr-app),
// licensed under the Apache License, Version 2.0. See LICENSE-Apache-2.0.txt
// beside this file.
//
// Changed from the original: it lists the changed files of the repo containing
// the focused folder and of every repo below it (repos.js finds them, ignore
// rules or not), in one list. Each repo is read by its own tool: jj (jj.js; the
// whole diff of @ in one call) or git (repos.js). The message box acts on the
// selected file's repo and names it: for jj it is multi-line, starts with the
// description of @, and a split button runs Describe with Commit behind its
// arrow; for git it runs Commit as the original does. A watched change re-reads
// only the repo it falls in, and one that lands during a refresh starts another.
// With several repos, a toggle groups the list by repository.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";
import {
  DIFF_ARGS, HEAD_ARGS, SNAPSHOT_ARGS, TRIGGER_ARGS,
  commitArgs, describeArgs, parseDiff, parseHead, snapshotsItself,
} from "./jj.js";
import { findRepos, gitCommitSteps, listRows, readGit } from "./repos.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const MAX_OUTPUT = 8 * 1024 * 1024;
const trimEnd = (text) => text.replace(/\s+$/, "");
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
// A path in a repo's own records: a commit, a jj operation, a new clone.
const META = /^(.*?)\/\.(git|jj)(\/|$)/;

// Runs fn over items, a few at a time: dozens of repos at once would start
// dozens of processes.
async function eachLimited(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

function previewLines(file) {
  if (file.binary) return ["Binary file changed"];
  if (!file.lines.length) return [file.from ? `Renamed from ${file.from}` : "No text diff available"];
  return file.lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
}

export default class JjChanges extends View {
  init(_props, cx) {
    this.repos = []; this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.shown = ""; this.target = null; this.handle = cx.focus_handle();
    this.input = TextareaState.new({ placeholder: "Message" });
    this.input.set_auto_grow(1, 6);
    this.input.on("change", (_e, cx) => {
      const before = this.message;
      this.message = this.input.value();
      if (Boolean(trimEnd(before)) !== Boolean(trimEnd(this.message)) || (before === this.shown) !== (this.message === this.shown)) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.grouped = localStorage.getItem("group-by-repo") === "1";
    this.collapsed = new Set(); // repo roots whose files the grouped list hides
    this.ticks = 0;
    this.refresh(cx, { search: true });
    // The folder watch reports changes as they happen. The timer covers what it
    // can't see: remote machines, and on Linux, folders the repo ignores.
    cx.timer.every(10000, (cx) => {
      this.ticks++;
      const slow = this.ticks % 6 === 0;
      if (!this.watched || slow) this.refresh(cx, { search: slow });
    });
  }

  watch(path, cx) {
    if (this.on || this.watched === path) return;
    this.watched = path;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === path) {
          const changed = await watchFolder(path);
          if (this.watched === path) this.changed(changed, path, cx);
        }
      } catch { this.watched = null; }
    });
  }

  // A changed path inside a repo re-reads that repo. A .git or .jj folder no
  // known repo owns means a repo appeared or went: look for repos again.
  changed(paths, root, cx) {
    if (paths.includes(root)) return this.refresh(cx, { search: true });
    const roots = this.repos.map((r) => r.root).sort((a, b) => b.length - a.length);
    const only = new Set();
    let search = false;
    for (const path of paths) {
      const meta = META.exec(path);
      if (meta) {
        if (roots.includes(meta[1])) only.add(meta[1]);
        else search = true;
        continue;
      }
      const owner = roots.find((r) => inside(path, r));
      if (owner) only.add(owner);
    }
    if (search || only.size) this.refresh(cx, { search, only: search ? null : only });
  }

  // `search` looks for repos again; `only` re-reads just those repos.
  refresh(cx, { search = false, only = null } = {}) {
    if (this.loading || this.busy) {
      // Merge into what's already waiting; a null `only` means every repo.
      const p = this.pending ?? { search: false, only: new Set() };
      this.pending = { search: p.search || search, only: p.only === null || only === null ? null : new Set([...p.only, ...only]) };
      return;
    }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.repos = []; this.files = []; this.open = null; this.target = null; this.truncated = false;
      this.setLines([]); this.message = ""; this.shown = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false; this.menu = false;
      search = true;
    }
    if (!cwd) return;
    this.loading = true; this.pending = null;
    cx.spawn(async (cx) => {
      try {
        const sh = (command, args, dir) => exec(command, args, { cwd: dir, on });
        const readText = (path) => readTextFile(path, { on });
        let targets = only ? this.repos.filter((r) => only.has(r.root)) : this.repos;
        if (search || !this.repos.length) {
          const found = await findRepos(sh, readText, cwd);
          if (key() !== context) return;
          const known = new Map(this.repos.map((r) => [r.root, r]));
          this.repos = found.repos.map((r) => known.get(r.root) ?? { ...r, files: [], head: null, error: null, selfSnapshot: null });
          this.truncated = found.truncated;
          targets = this.repos;
        }
        await eachLimited(targets, 6, (repo) => this.read(repo, sh, readText));
        if (key() !== context) return;
        this.start = cwd; this.on = on;
        this.error = this.repos.length ? null : "No git or jj repository here.";
        this.flatten();
        const outer = this.repos.find((r) => inside(cwd, r.root));
        this.watch(outer?.root ?? cwd, cx);
        if (this.open && !this.files.some((f) => f.key === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].key;
        if (this.open) this.setLines(previewLines(this.files.find((f) => f.key === this.open)));
        this.retarget();
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending) this.refresh(cx, this.pending);
      }
    });
  }

  async read(repo, sh, readText) {
    try {
      if (repo.kind === "jj") {
        const jj = async (args) => {
          const r = await sh("jj", args, repo.root);
          if (r.code !== 0) throw new Error(trimEnd(r.stderr || r.stdout));
          return r.stdout;
        };
        // Reads skip jj's snapshot; where watchman doesn't take one on every
        // change, take it here first.
        if (repo.selfSnapshot === null) repo.selfSnapshot = snapshotsItself(await sh("jj", TRIGGER_ARGS, repo.root));
        if (!repo.selfSnapshot) await jj(SNAPSHOT_ARGS);
        repo.head = parseHead(await jj(HEAD_ARGS));
        const diff = await jj(DIFF_ARGS);
        if (diff.length >= MAX_OUTPUT) throw new Error("This change is too large to show here. Use jj diff in a terminal.");
        repo.files = parseDiff(diff);
      } else {
        const nested = this.repos.filter((r) => r !== repo && inside(r.root, repo.root)).map((r) => r.root);
        repo.files = await readGit(sh, readText, repo.root, nested);
      }
      repo.error = null;
    } catch (e) { repo.files = []; repo.error = String(e.message ?? e); }
  }

  // One list for every repo, each path shown from the focused folder.
  flatten() {
    const files = [];
    for (const repo of this.repos) {
      const prefix = repo.root !== this.start && inside(repo.root, this.start) ? `${repo.root.slice(this.start.length + 1)}/` : "";
      for (const f of repo.files) files.push({ ...f, repo: repo.root, key: `${repo.root}:${f.path}`, display: prefix + f.path });
    }
    files.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
    this.files = files.slice(0, 1000); this.limited = files.length > 1000;
  }

  label(repo) {
    return inside(this.start ?? "", repo.root) ? repo.root.split("/").pop() : repo.root.slice(this.start.length + 1);
  }

  // The repo the message box acts on: the selected file's, else the first with
  // changes, else the one containing the focused folder.
  targetRepo() {
    const root = this.files.find((f) => f.key === this.open)?.repo ?? this.files[0]?.repo;
    return this.repos.find((r) => r.root === root) ?? this.repos.find((r) => inside(this.start ?? "", r.root)) ?? this.repos[0] ?? null;
  }

  // Shows the target repo's description of @ in the box (empty for git),
  // unless the box holds unsaved typing.
  retarget() {
    const repo = this.targetRepo();
    this.target = repo?.root ?? null;
    const text = repo?.kind === "jj" ? trimEnd(repo.head?.description ?? "") : "";
    if (this.message !== this.shown || text === this.shown) return;
    this.shown = text; this.message = text; this.input.set_value(text);
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(fileKey, cx) {
    this.open = this.open === fileKey ? null : fileKey; this.note = null;
    this.closed = !this.open;
    this.setLines(this.open ? previewLines(this.files.find((f) => f.key === fileKey)) : []);
    this.retarget();
    cx.notify();
  }

  // Runs jj describe, jj commit, or git add -A and git commit in the target repo.
  run(action, cx) {
    this.menu = false;
    const message = trimEnd(this.message), repo = this.targetRepo();
    if (!message || !repo || this.busy || this.loading || this.context !== key()) return;
    if (action === "describe" && message === this.shown) return;
    const context = this.context, on = this.on;
    const steps = repo.kind === "git" ? gitCommitSteps(message) : [action === "commit" ? commitArgs(message) : describeArgs(message)];
    this.busy = action; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec(repo.kind, args, { cwd: repo.root, on });
          if (r.code !== 0) throw new Error(trimEnd(r.stderr || r.stdout));
        }
        if (key() === context) {
          const text = action === "describe" ? message : "";
          this.shown = text; this.message = text; this.input.set_value(text);
        }
      } catch (e) { if (key() === context) this.note = `${action === "describe" ? "Describe" : "Commit"} failed: ${e.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx, { only: new Set([repo.root]) }); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // jj: Describe, with Commit behind the arrow. git: Commit.
  actionButton(t, repo) {
    const ready = Boolean(trimEnd(this.message) && repo && !this.busy && !this.loading);
    if (repo?.kind === "git") {
      return div().id("commit").flex_none().h(32).px(14).flex().items_center().rounded(8).text_size(12)
        .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
        .when(ready, (e) => e.cursor_pointer()).on_click((_e, cx) => this.run("commit", cx)).child(this.busy ? "Committing…" : "Commit");
    }
    const canDescribe = ready && trimEnd(this.message) !== this.shown;
    const label = this.busy === "commit" ? "Committing…" : this.busy === "describe" ? "Describing…" : "Describe";
    return h_flex().flex_none().h(32).rounded(8).overflow_hidden().text_size(12)
      .child(div().id("describe").h_full().px(14).flex().items_center().bg(canDescribe ? t.solid : t.raised).text_color(canDescribe ? t.solid_foreground : t.dim)
        .when(canDescribe, (e) => e.cursor_pointer()).on_click((_e, cx) => this.run("describe", cx)).child(label))
      .child(div().w(1).h_full().bg(t.border))
      .child(div().id("more-actions").h_full().px(8).flex().items_center().bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
        .when(ready, (e) => e.cursor_pointer()).on_click((_e, cx) => { if (ready) { this.menu = !this.menu; cx.notify(); } }).child("▾"));
  }

  actionsMenu(t) {
    return v_flex().id("actions-menu").absolute().right(10).bottom(48).w(240).p(4).rounded(8).bg(t.background).border_1().border_color(t.border).shadow_md()
      .on_mouse_down_out((_e, cx) => { this.menu = false; cx.notify(); })
      .child(v_flex().id("commit").px(10).py(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.run("commit", cx))
        .child(div().text_size(12).child("Commit"))
        .child(div().text_size(11).text_color(t.dim).child("Describe @, then start a new change")));
  }

  toggleGroup(cx) {
    this.grouped = !this.grouped;
    localStorage.setItem("group-by-repo", this.grouped ? "1" : "0");
    cx.notify();
  }

  repoRow(row, t, mono) {
    return h_flex().id(`repo-${row.root}`).h(28).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.collapsed.has(row.root) ? this.collapsed.delete(row.root) : this.collapsed.add(row.root); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${row.collapsed ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_shrink(0).max_w(220).truncate().text_size(12).font_semibold().child(row.label))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).font_family(mono).child(row.kind === "jj" && row.head ? `jj @${row.head.change}` : row.kind))
      .child(div().text_size(11).text_color(t.muted).child(String(row.count)))
      .when(row.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${row.add}`))).when(row.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${row.del}`)));
  }

  fileRow({ file: f, text }, t, indent) {
    const parts = text.split("/"), name = parts.pop();
    return h_flex().id(`change-${f.key}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(indent, (e) => e.pl(25)).when(this.open === f.key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.key, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const mono = settings().font_family ?? "JetBrains Mono";
    const target = this.repos.find((r) => r.root === this.target);
    const spanned = new Set(this.files.map((f) => f.repo)).size;
    const failed = this.repos.filter((r) => r.error);
    const grouping = this.grouped && this.repos.length > 1;
    const rows = listRows(this.files, this.repos, { grouped: grouping, start: this.start, labelOf: (r) => this.label(r), collapsed: this.collapsed });
    return v_flex().id("jj-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.menu) { this.menu = false; cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files${spanned > 1 ? ` · ${spanned} repos` : ""}`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .when(this.repos.length > 1, (e) => e.child(div().id("group-by-repo").size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .when(this.grouped, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip("Group by repository").on_click((_e, cx) => this.toggleGroup(cx))
          .child(svg("mods/workspace-chrome/layers.svg").size(14).text_color(this.grouped ? t.foreground : t.dim)))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(rows.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(rows.map((row) => (row.type === "repo" ? this.repoRow(row, t, mono) : this.fileRow(row, t, grouping))))
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading && !this.repos.length ? "Loading changes…" : this.repos.length ? "No changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.truncated), el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Stopped looking after ${this.repos.length} repositories`)))
      .children(failed.map((r) => div().px(12).py(2).text_size(11).text_color(t.ansi1).truncate().child(`${this.label(r)}: ${r.error}`)))
      .child(div().flex_1().min_h(0).relative().font_family(mono).text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(v_flex().relative().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .when(Boolean(target), (e) => e.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().text_color(t.muted).child(this.label(target)))
          .child(div().font_family(mono).child(target.kind === "jj" && target.head ? `jj @${target.head.change}` : target.kind))
          .when(Boolean(target.head?.conflict), (e) => e.child(div().px(5).rounded(4).border_1().border_color(t.ansi1).text_size(10).text_color(t.ansi1).child("conflict")))))
        .child(h_flex().gap(8).items_end()
          .child(div().id("description").flex_1().min_w(0).px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).text_size(12).text_color(t.foreground)))
          .child(this.actionButton(t, target)))
        .when(this.menu, (e) => e.child(this.actionsMenu(t))));
  }
}

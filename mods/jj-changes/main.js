// jj-changes: a jj version of Herdr's Changes panel.
//
// Derived from defaults/mods/changes/main.js in herdr-app 0.1.12
// (https://github.com/herdrdev/herdr-app), licensed under the Apache License,
// Version 2.0. See LICENSE-Apache-2.0.txt beside this file.
//
// Changed from the original: it reads jj instead of Git (commands and parsing
// in jj.js) and works only in jj repos; the whole diff of @ loads in one call;
// the message box is multi-line and starts with the description of @; a split
// button runs Describe, with Commit behind its arrow; and a change that lands
// during a refresh starts another refresh.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings } from "herdr";
import {
  DIFF_ARGS, HEAD_ARGS, ROOT_ARGS, SNAPSHOT_ARGS, TRIGGER_ARGS,
  commitArgs, describeArgs, parseDiff, parseHead, snapshotsItself,
} from "./jj.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const MAX_OUTPUT = 8 * 1024 * 1024;
const trimEnd = (text) => text.replace(/\s+$/, "");

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
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
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.shown = ""; this.handle = cx.focus_handle();
    this.input = TextareaState.new({ placeholder: "Describe this change" });
    this.input.set_auto_grow(1, 6);
    this.input.on("change", (_e, cx) => {
      const before = this.message;
      this.message = this.input.value();
      if (Boolean(trimEnd(before)) !== Boolean(trimEnd(this.message)) || (before === this.shown) !== (this.message === this.shown)) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // Puts the description of @ in the box, unless the box holds unsaved typing.
  showDescription(description) {
    const text = trimEnd(description);
    if (this.message !== this.shown || text === this.shown) return;
    this.shown = text; this.message = text; this.input.set_value(text);
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.pending = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.head = null; this.selfSnapshot = null;
      this.setLines([]); this.message = ""; this.shown = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false; this.menu = false;
    }
    if (!cwd) return;
    this.loading = true; this.pending = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("jj", ROOT_ARGS, { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.files = []; this.head = null; this.setLines([]); this.open = null;
          this.error = "Not a jj repository. Run jj git init --colocate to use jj here.";
          return;
        }
        const root = top.stdout.trim(), jj = async (args) => {
          const r = await exec("jj", args, { cwd: root, on });
          if (r.code !== 0) throw new Error(trimEnd(r.stderr || r.stdout));
          return r.stdout;
        };
        if (this.selfSnapshot === null) this.selfSnapshot = snapshotsItself(await exec("jj", TRIGGER_ARGS, { cwd: root, on }));
        if (!this.selfSnapshot) await jj(SNAPSHOT_ARGS);
        const head = parseHead(await jj(HEAD_ARGS));
        const diff = await jj(DIFF_ARGS);
        if (diff.length >= MAX_OUTPUT) throw new Error("This change is too large to show here. Use jj diff in a terminal.");
        const files = parseDiff(diff);
        if (key() !== context) return;
        this.root = root; this.on = on; this.head = head; this.files = files.slice(0, 1000); this.limited = files.length > 1000; this.error = null;
        this.showDescription(head.description);
        this.watch(root, cx);
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && this.files.length) this.open = this.files[0].path;
        if (this.open) this.setLines(previewLines(this.files.find((f) => f.path === this.open)));
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending) this.refresh(cx);
      }
    });
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.note = null;
    this.closed = !this.open;
    this.setLines(this.open ? previewLines(this.files.find((f) => f.path === path)) : []);
    cx.notify();
  }

  // Runs `jj describe` or `jj commit` with the box's text.
  run(action, cx) {
    this.menu = false;
    const message = trimEnd(this.message);
    if (!message || !this.root || this.busy || this.loading || this.context !== key()) return;
    if (action === "describe" && message === this.shown) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = action; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("jj", action === "commit" ? commitArgs(message) : describeArgs(message), { cwd: root, on });
        if (r.code !== 0) throw new Error(trimEnd(r.stderr || r.stdout));
        if (key() === context) {
          const text = action === "commit" ? "" : message;
          this.shown = text; this.message = text; this.input.set_value(text);
        }
      } catch (e) { if (key() === context) this.note = `${action === "commit" ? "Commit" : "Describe"} failed: ${e.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  splitButton(t) {
    const ready = Boolean(trimEnd(this.message) && this.root && !this.busy && !this.loading);
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

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    return v_flex().id("jj-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.menu) { this.menu = false; cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(this.head), (e) => e.child(div().text_size(11).text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(`@ ${this.head.change}`)))
        .when(Boolean(this.head?.conflict), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.ansi1).text_size(10).text_color(t.ansi1).child("conflict")))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading && !this.head ? "Loading changes…" : this.root ? "No changes in @" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().relative().flex_none().p(10).gap(8).items_end().border_t(1).border_color(t.border)
        .child(div().id("description").flex_1().min_w(0).px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).text_size(12).text_color(t.foreground)))
        .child(this.splitButton(t))
        .when(this.menu, (e) => e.child(this.actionsMenu(t))));
  }
}

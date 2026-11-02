// jj-graph: the jj log graph of the focused folder's workspace. graph.js reads
// jj's JSON, lanes.js lays the changes out, and this draws the lanes as paths.
// Click a change to select it; right-click it for its menu. The field above the
// graph takes a revset, applied with Enter and remembered per repo while the
// panel runs; empty means the person's revsets.log.
// Opened as a popup with props { role: "menu", ... }, this mod draws that menu.
//
// location() and the panel and menu layouts follow defaults/mods/changes and
// defaults/mods/menu in herdr-app 0.1.12 (https://github.com/herdrdev/herdr-app),
// licensed under the Apache License, Version 2.0. See LICENSE-Apache-2.0.txt.

import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, openOverlay, closeOverlay } from "herdr";
import { discover } from "./jj-repo.js";
import { LIMIT, defaultRevset, graphEdges, logArgs, parseLog, runAction } from "./graph.js";
import { graphWidth, laneX, layout, segmentPath } from "./lanes.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => { const { cwd, on } = location(); return JSON.stringify([cwd, on]); };
const shell = (on) => (command, args, cwd) => exec(command, args, { cwd, on });
const mono = () => settings().font_family ?? "JetBrains Mono";
const ROW = 22;
const zoom = () => settings().zoom ?? 1;
// A row is a whole number of screen pixels, or lines show hairline gaps
// between rows; rowH is that height in the units h() takes (zoom scales it).
const rowH = () => Math.max(1, Math.round(ROW * zoom())) / zoom();
const laneColors = (t) => [t.ansi4, t.ansi5, t.ansi6, t.ansi3, t.ansi2, t.ansi1];

const MENU = [
  ["Edit", "edit", (p) => !p.immutable && !p.current],
  ["New change on top", "new", () => true],
  ["New workspace from here…", "workspace", () => true],
  ["Squash into parent", "squash", (p) => !p.immutable],
  ["Abandon", "abandon", (p) => !p.immutable],
];

export default class JjGraph extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.role === "menu") {
      this.at = MENU.findIndex(([, , ok]) => ok(props()));
      this.handle.focus();
      return;
    }
    this.changes = []; this.rows = []; this.lanes = 1; this.width = 0;
    this.revsets = new Map(); // repo -> the revset typed for it
    this.defaults = new Map(); // repo -> its revsets.log
    this.revset = "";
    this.input = InputState.new({ placeholder: "Revset" });
    this.input.on("submit", (_e, cx) => {
      this.revset = this.input.value().trim();
      if (this.repo) this.revsets.set(this.repo.main, this.revset);
      this.refresh(cx);
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(path, cx) {
    if (this.on || this.watched === path) return;
    this.watched = path;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === path) {
          await watchFolder(path);
          if (this.watched === path) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.pending = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.repo = null; this.changes = []; this.rows = []; this.lanes = 1; this.width = 0; this.selected = null; this.error = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.pending = false;
    cx.spawn(async (cx) => {
      try {
        const sh = shell(on);
        const repo = await discover(sh, (path) => readTextFile(path, { on }), cwd);
        if (key() !== context) return;
        if (!repo) { this.repo = null; this.changes = []; this.rows = []; this.error = "Not a jj repository."; return; }
        if (repo.main !== this.repo?.main) {
          this.revset = this.revsets.get(repo.main) ?? "";
          this.input.set_value(this.revset);
        }
        this.repo = repo; this.on = on;
        // A revset jj refuses leaves the last good graph up, under its error.
        const r = await sh("jj", logArgs(this.revset), repo.top);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "jj log failed");
        if (key() !== context) return;
        const parsed = parseLog(r.stdout);
        if (!this.defaults.has(repo.main)) this.defaults.set(repo.main, await defaultRevset(sh, repo.top));
        const edges = await graphEdges(sh, repo.top, parsed, this.revset || this.defaults.get(repo.main));
        if (key() !== context) return;
        this.error = null;
        this.changes = parsed.map((c, i) => ({ ...c, edges: edges[i] }));
        const { rows, width } = layout(this.changes);
        this.rows = rows; this.lanes = width;
        this.width = this.graphWidth() + Math.max(300, ...this.changes.map((c) => (12 + c.description.length + c.bookmarks.join(" ").length + c.workspaces.join(" ").length) * 7 + 40));
        this.watch(`${repo.main}/.jj/repo/op_heads`, cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending) this.refresh(cx);
      }
    });
  }

  byCommit(commit) {
    return this.changes.find((c) => c.commit === commit);
  }

  graphWidth() {
    return graphWidth(this.lanes);
  }

  openMenu(row) {
    const { space } = location();
    openOverlay({
      mod: "jj-graph", kind: "popup", width: 260, height: 220,
      props: { role: "menu", cwd: this.repo.top, on: this.on ?? null, space, commit: row.commit, change: row.change.prefix + row.change.rest, description: row.description, immutable: row.immutable, current: row.current },
    });
  }

  // The lanes through one row: one stroked path per color, and the change's node.
  graphCell(row, change, t) {
    const h = rowH(), colors = laneColors(t);
    const paths = new Map();
    for (const segment of row.segments) {
      const [, , , , c, dashed] = segment;
      const color = colors[c % colors.length], key = `${color}${dashed ? "-" : ""}`;
      let p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
      const { from, to, controls } = segmentPath(segment, this.lanes);
      p = p.move_to(...from);
      p = controls ? p.cubic_bezier_to(...to, ...controls[0], ...controls[1]) : p.line_to(...to);
      paths.set(key, { p, color });
    }
    const size = change.current ? 10 : 8;
    const node = div().absolute().left(laneX(row.lane) - size / 2).top(h / 2 - size / 2).size(size);
    return div().relative().flex_none().w(this.graphWidth()).h(h).overflow_hidden()
      .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
      .child(change.current ? node.rounded(5).bg(t.background).border(2).border_color(t.ansi2)
        : change.conflict ? node.rounded(4).bg(t.ansi1)
        : change.immutable ? node.rounded(1).bg(t.dim)
        : node.rounded(4).bg(colors[row.lane % colors.length]));
  }

  // Rows can't carry handlers: the list's on_item_click and
  // on_item_secondary_click get the row's key, which is its commit id.
  row(i, t) {
    const change = this.changes[i];
    return h_flex().w_full().h(rowH()).flex_none().pr(10).gap(6).items_center().cursor_pointer()
      .when(this.selected === change.commit, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(this.graphCell(this.rows[i], change, t))
      .child(h_flex().flex_none().child(div().font_bold().text_color(t.ansi5).child(change.change.prefix)).child(div().text_color(t.dim).child(change.change.rest)))
      .children(change.bookmarks.map((b) => div().flex_none().text_color(t.ansi4).child(b)))
      .children(change.workspaces.map((w) => div().flex_none().text_color(t.ansi2).child(`${w}@`)))
      .when(change.conflict, (e) => e.child(div().flex_none().text_color(t.ansi1).child("(conflict)")))
      .when(change.empty, (e) => e.child(div().flex_none().text_color(t.ansi2).child("(empty)")))
      .child(div().flex_none().text_color(change.description ? t.foreground : t.ansi3).child(change.description || "(no description set)"));
  }

  render(cx) {
    if (props()?.role === "menu") return this.renderMenu(cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const note = this.error ? null : !this.changes.length && this.loading ? "Loading…" : this.repo && !this.changes.length ? "No changes in this revset." : null;
    return v_flex().id("jj-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Graph"))
        .when(Boolean(this.repo), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.repo.name))))
      .child(v_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border)
        .child(div().id("revset").w_full().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border)
          .font_family(mono()).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        // jj points at a revset's mistake with a caret diagram, which needs a monospace font.
        .when(Boolean(this.error), (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.ansi1).child(this.error)))
        .when(this.changes.length >= LIMIT, (e) => e.child(div().text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT} changes`))))
      .child(div().flex_1().min_h(0).relative().font_family(mono()).text_size(11.5)
        .when(Boolean(note), (e) => e.child(div().p(12).text_color(t.dim).child(note)))
        .child(div().id("graph-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("graph-rows", this.changes.length, rowH(), (i) => this.changes[i].commit,
            (range) => Array.from({ length: range.end - range.start }, (_, n) => this.row(range.start + n, t))).size_full()
            .on_item_click((key, cx) => { if (this.byCommit(key)) { this.selected = key; cx.notify(); } })
            .on_item_secondary_click((key, _e, cx) => {
              const row = this.byCommit(key);
              if (!row) return;
              this.selected = key; cx.notify();
              this.openMenu(row);
            }))))
        .child(Scrollbar.vertical("graph-rows").viewport_from_layout().absolute().inset_0()));
  }

  choose(i, cx) {
    const p = props(), [, action, ok] = MENU[i] ?? [];
    if (!action || !ok(p) || this.busy) return;
    if (action === "workspace") {
      closeOverlay(p.overlay);
      openOverlay({ mod: "jj-workspaces", kind: "dialog", width: 460, height: 280, props: { space: p.space, folder: p.cwd, machine: p.on, action: "new", revision: p.commit, from: p.change } });
      return;
    }
    this.busy = action; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await runAction(shell(p.on), p.cwd, action, p.commit);
        closeOverlay(p.overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  renderMenu(cx) {
    const t = theme(), p = props();
    return v_flex().id("jj-graph-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        const n = MENU.length;
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`${p.change} · ${p.description || "(no description set)"}`))
      .children(MENU.map(([label, action, ok], i) => v_flex()
        .when(action === "squash", (e) => e.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`gm-${i}`).h(31).px(8).rounded(7).items_center()
          .text_color(ok(p) ? t.foreground : t.dim)
          .when(ok(p) && i === this.at, (e) => e.bg(t.selected))
          .when(ok(p), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(i, cx)))
          .child(div().flex_1().child(this.busy === action ? "Working…" : label)))))
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(6).text_size(11).text_color(t.blocked).child(this.error)));
  }
}

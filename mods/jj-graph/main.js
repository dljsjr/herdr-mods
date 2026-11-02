// jj-graph: the jj log graph of the focused folder's workspace, drawn by jj
// itself (graph.js). Click a change to select it; right-click it for its menu.
// Opened as a popup with props { role: "menu", ... }, this mod draws that menu.
//
// location() and the panel and menu layouts follow defaults/mods/changes and
// defaults/mods/menu in herdr-app 0.1.12 (https://github.com/herdrdev/herdr-app),
// licensed under the Apache License, Version 2.0. See LICENSE-Apache-2.0.txt.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, openOverlay, closeOverlay } from "herdr";
import { discover } from "./jj-repo.js";
import { LOG_ARGS, parseLog, runAction } from "./graph.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => { const { cwd, on } = location(); return JSON.stringify([cwd, on]); };
const shell = (on) => (command, args, cwd) => exec(command, args, { cwd, on });
const NODES = "@○◆×◉●◇";
const mono = () => settings().font_family ?? "JetBrains Mono";

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
    this.rows = []; this.width = 0;
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
      this.context = context; this.repo = null; this.rows = []; this.width = 0; this.selected = null; this.error = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.pending = false;
    cx.spawn(async (cx) => {
      try {
        const sh = shell(on);
        const repo = await discover(sh, (path) => readTextFile(path, { on }), cwd);
        if (key() !== context) return;
        if (!repo) { this.repo = null; this.rows = []; this.error = "Not a jj repository."; return; }
        const r = await sh("jj", LOG_ARGS, repo.top);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "jj log failed");
        if (key() !== context) return;
        this.repo = repo; this.on = on; this.error = null;
        this.rows = parseLog(r.stdout);
        this.width = Math.max(300, ...this.rows.map((row) => (row.graph.length + (row.commit ? 30 + row.description.length + row.bookmarks.join(" ").length : 0)) * 7 + 40));
        this.watch(`${repo.main}/.jj/repo/op_heads`, cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending) this.refresh(cx);
      }
    });
  }

  byCommit(commit) {
    return this.rows.find((r) => r.commit === commit);
  }

  openMenu(row) {
    const { space } = location();
    openOverlay({
      mod: "jj-graph", kind: "popup", width: 260, height: 220,
      props: { role: "menu", cwd: this.repo.top, on: this.on ?? null, space, commit: row.commit, change: row.change.prefix + row.change.rest, description: row.description, immutable: row.immutable, current: row.current },
    });
  }

  graph(row, t) {
    const at = row.commit ? [...row.graph].findIndex((c) => NODES.includes(c)) : -1;
    if (at < 0) return div().flex_none().text_color(t.dim).child(row.graph);
    const chars = [...row.graph];
    const node = chars[at];
    return h_flex().flex_none()
      .child(div().text_color(t.dim).child(chars.slice(0, at).join("")))
      .child(div().text_color(node === "@" ? t.ansi2 : node === "×" ? t.ansi1 : node === "◆" ? t.dim : t.foreground).child(node))
      .child(div().text_color(t.dim).child(chars.slice(at + 1).join("")));
  }

  // Rows can't carry handlers: the list's on_item_click and
  // on_item_secondary_click get the row's key, which is its commit id.
  row(row, t) {
    const line = h_flex().w_full().h(20).flex_none().px(10).items_center().child(this.graph(row, t));
    if (!row.commit) return line;
    return line.gap(6).cursor_pointer().rounded(4)
      .when(this.selected === row.commit, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(h_flex().flex_none().child(div().font_bold().text_color(t.ansi5).child(row.change.prefix)).child(div().text_color(t.dim).child(row.change.rest)))
      .children(row.bookmarks.map((b) => div().flex_none().text_color(t.ansi4).child(b)))
      .children(row.workspaces.map((w) => div().flex_none().text_color(t.ansi2).child(`${w}@`)))
      .when(row.conflict, (e) => e.child(div().flex_none().text_color(t.ansi1).child("(conflict)")))
      .when(row.empty, (e) => e.child(div().flex_none().text_color(t.ansi2).child("(empty)")))
      .child(div().flex_none().text_color(row.description ? t.foreground : t.ansi3).child(row.description || "(no description set)"));
  }

  render(cx) {
    if (props()?.role === "menu") return this.renderMenu(cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    return v_flex().id("jj-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Graph"))
        .when(Boolean(this.repo), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.repo.name))))
      .child(div().flex_1().min_h(0).relative().font_family(mono()).text_size(11.5)
        .when(Boolean(this.error) || (!this.rows.length && this.loading), (e) => e.child(div().p(12).text_color(t.dim).child(this.error || "Loading…")))
        .child(div().id("graph-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("graph-rows", this.rows.length, 20, (i) => this.rows[i]?.commit ?? `line-${i}`,
            (range) => this.rows.slice(range.start, range.end).map((row) => this.row(row, t))).size_full()
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

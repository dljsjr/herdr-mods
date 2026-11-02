// jj workspace dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { tab, argv }.
//
// Derived from defaults/mods/worktree/main.js in herdr-app 0.1.12
// (https://github.com/herdrdev/herdr-app), licensed under the Apache License,
// Version 2.0. See LICENSE-Apache-2.0.txt beside this file.
//
// Changed from the original: it manages jj workspaces instead of Git
// worktrees, following the old herdr-jj plugin (commands in workspaces.js).
// New workspaces start from trunk() under ~/.herdr/jj-workspaces. Removal
// drops the submodule and uncommitted-change warnings, because jj snapshots
// the checkout first, and closes the space only after jj succeeds. Remote
// machines need a POSIX shell (no PowerShell fallback).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, readTextFile, home } from "herdr";
import { discover } from "./jj-repo.js";
import { checkoutPath, createWorkspace, currentName, listWorkspaces, removeWorkspace } from "./workspaces.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

const tilde = (path, userHome) => (userHome && path.startsWith(userHome) ? `~${path.slice(userHome.length)}` : path);
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on) {
  return spaces().find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s);
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.root && c.root !== path && c.root.length > path.length && inside(at, c.root));
  })());
}

export default class JjWorkspaces extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.sh = (command, args, cwd) => exec(command, args, { cwd, on: this.on });
    this.readText = (path) => readTextFile(path, { on: this.on });
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = "";
    this.list = undefined; // open: the workspaces, once read
    this.at = 0;
    this.input = InputState.new({ placeholder: this.opening ? "filter workspaces" : "workspace name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (props()?.action !== "remove") {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in jj
    this.name = ""; // remove: the workspace's jj name
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim();
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until what it acts on is known.
        const repo = await discover(this.sh, this.readText, this.folder);
        if (repo && props().action === "remove" && repo.linked) this.name = await currentName(this.sh, repo);
        if (repo && this.opening) this.list = await listWorkspaces(this.sh, repo);
        this.repo = repo;
      } catch (error) { this.repo = null; this.error = String(error.message ?? error); }
      cx.notify();
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    if (this.opening) return this.open(this.shown()[this.at]);
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error.message ?? error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const name = this.text.trim();
    if (!name) throw new Error("Type a workspace name.");
    const path = await createWorkspace(this.sh, this.repo, this.userHome, name);
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.name} ${c.description} ${c.root ?? ""}`.toLowerCase().includes(f));
  }

  // Enter can reach this from both the filter's submit and the key handler.
  open(c) {
    if (!c?.available || this.opened) return;
    this.opened = true;
    this.close();
    const s = spaceOf(c.root, this.list, this.on);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.root, machine: this.on });
  }

  async remove() {
    const top = this.repo.top;
    await removeWorkspace(this.sh, this.repo);
    for (const s of spaces()) {
      const at = place(s);
      if ((s.machine ?? null) === (this.on ?? null) && at && inside(at, top)) run("space.close", { id: s.id, confirmed: true });
    }
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const row = (c, i) => {
      const on = i === this.at;
      const there = c.available && spaceOf(c.root, all, this.on);
      return v_flex()
        .id(`ws-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .when(c.available, (el) => el.cursor_pointer())
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_none().text_color(c.available ? t.foreground : t.dim).child(c.name))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c.description || c.change))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main workspace")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!c.available, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("missing"))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(c.root ? tilde(c.root, this.userHome) : "no checkout"));
    };
    const count = rows.length === all.length ? `${all.length} workspaces` : `${rows.length}/${all.length} workspaces`;
    return v_flex()
      .id("jj-workspaces")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open jj workspace${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(this.error || `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a jj repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("ws-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching workspaces."))),
              )
              .child(Scrollbar.vertical("ws-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const r = this.repo;
    const title = remove ? `Remove jj workspace ${this.name}?` : `New jj workspace${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a jj repository.`
          : remove
            ? !r.linked
              ? "This is the repo's main workspace, which jj keeps the repo in."
              : `Closes its spaces and deletes ${tilde(r.top, this.userHome)}. jj snapshots it first, so its tracked changes stay in history; files jj doesn't track are deleted.`
            : `A new space on a checkout in ${tilde(checkoutPath(this.userHome ?? "", r, "x").replace(/\/x$/, ""), this.userHome)}/, starting from trunk().`;
    const blocked = !r || (remove && !r.linked);
    return v_flex()
      .id("jj-workspaces")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(!remove && !blocked, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .child(this.busy ? "working…" : blocked ? "esc close" : remove ? "↵ remove · esc cancel" : "↵ create · esc cancel"),
      );
  }
}

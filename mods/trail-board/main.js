// trail-board: the Trail tasks of the focused folder's project as a board.
// board.js reads them through the trail CLI. Lanes stack as sections in a
// narrow panel and stand side by side when it is wide. Click a card for its
// details, which open as a dialog drawn by this mod with props { role:
// "detail", root, on, key }.
//
// location() follows defaults/mods/changes in herdr-app 0.1.12
// (https://github.com/herdrdev/herdr-app), licensed under the Apache License,
// Version 2.0. See LICENSE-Apache-2.0.txt beside this file.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, TextView } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, openOverlay, closeOverlay } from "herdr";
import { findProject, lanes, readTask, readTasks, tasksDir } from "./board.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const shell = (on) => (command, args, cwd) => exec(command, args, { cwd, on });
const mono = () => settings().font_family ?? "JetBrains Mono";
const WIDE = 720; // px from which lanes stand side by side
const LANE_NAMES = { "NOT STARTED": "Not started", "IN PROGRESS": "In progress", "NEEDS REVIEW": "Needs review" };
const priorityColor = (t, p) => (p === "HIGH" ? t.ansi1 : p === "MEDIUM" ? t.ansi3 : t.dim);
// Changes inside a repo's own records don't change tasks.
const META = /\/\.(git|jj)(\/|$)/;

export default class TrailBoard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.role === "detail") return this.initDetail(cx);
    this.tasks = []; this.project = null; this.filter = null; this.query = ""; this.width = 0;
    this.collapsed = new Set(); // lanes a narrow board folds
    this.found = new Map(); // folder -> its trail project, once looked up
    this.search = InputState.new({ placeholder: "Search tasks" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.ticks = 0;
    this.refresh(cx);
    // The folder watch reports changes; the timer covers remote machines.
    cx.timer.every(10000, (cx) => {
      this.ticks++;
      if (!this.watched || this.ticks % 6 === 0) this.refresh(cx);
    });
  }

  // Watches the tasks folder, or with a trail too old to name it, the whole
  // project. A burst of changes becomes one refresh.
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const changed = await watchFolder(root);
          if (this.watched !== root || changed.every((p) => META.test(p))) continue;
          if (this.scheduled) continue;
          this.scheduled = true;
          cx.timer.after(1000, (cx) => { this.scheduled = false; this.refresh(cx); });
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.pending = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.project = null; this.tasks = []; this.error = null; this.watched = null; this.filter = null;
    }
    if (!cwd) return;
    this.loading = true; this.pending = false;
    cx.spawn(async (cx) => {
      try {
        const sh = shell(on);
        if (!this.found.has(cwd)) {
          const project = await findProject(sh, cwd);
          if (project) project.tasksDir = await tasksDir(sh, project.root);
          this.found.set(cwd, project);
        }
        const project = this.found.get(cwd);
        if (key() !== context) return;
        if (!project) { this.project = null; this.tasks = []; this.error = "No Trail tasks here."; return; }
        const tasks = await readTasks(sh, project.root);
        if (key() !== context) return;
        this.project = project; this.on = on; this.tasks = tasks; this.error = null;
        if (this.filter && !tasks.some((t) => t.project === this.filter)) this.filter = null;
        this.watch(project.tasksDir ?? project.root, cx);
      } catch (e) {
        if (key() === context) { this.error = String(e.message ?? e); this.found.delete(cwd); }
      } finally {
        this.loading = false; cx.notify();
        if (this.pending) this.refresh(cx);
      }
    });
  }

  openCard(card) {
    openOverlay({ mod: "trail-board", kind: "dialog", width: 680, height: 0.8, props: { role: "detail", root: this.project.root, on: this.on ?? null, key: card.key } });
  }

  card(c, t) {
    const done = c.subtasks ? `${c.subtasks.done}/${c.subtasks.total} subtasks` : null;
    const assignee = c.assignee && c.assignee !== "UNASSIGNED" ? c.assignee : null;
    return h_flex().id(`card-${c.key}`).flex_none().w_full().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openCard(c))
      .child(div().w(3).self_stretch().flex_none().bg(priorityColor(t, c.priority)))
      .child(v_flex().flex_1().min_w(0).px(9).py(7).gap(3)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().font_family(mono()).text_color(t.dim).child(c.key))
          .when(c.kind === "BUG", (e) => e.child(div().px(4).rounded(3).border_1().border_color(t.ansi1).text_size(10).text_color(t.ansi1).child("bug")))
          .child(div().flex_1())
          .child(div().text_size(10).text_color(priorityColor(t, c.priority)).child(c.priority)))
        .child(div().text_size(12.5).whitespace_normal().child(c.title))
        .when(Boolean(assignee || done || c.blockedBy?.length), (e) => e.child(h_flex().gap(8).text_size(11).text_color(t.dim)
          .when(Boolean(assignee), (e) => e.child(div().child(assignee)))
          .when(Boolean(done), (e) => e.child(div().child(done)))
          .when(Boolean(c.blockedBy?.length), (e) => e.child(div().text_color(t.ansi1).child(`blocked by ${c.blockedBy.join(", ")}`))))));
  }

  laneHeader(lane, t, foldable) {
    const shut = foldable && this.collapsed.has(lane.status);
    return h_flex().id(`lane-${lane.status}`).h(28).flex_none().px(4).gap(6).items_center()
      .when(foldable, (e) => e.cursor_pointer().on_click((_e, cx) => { shut ? this.collapsed.delete(lane.status) : this.collapsed.add(lane.status); cx.notify(); }))
      .when(foldable, (e) => e.child(svg(`mods/workspace-chrome/chevron-${shut ? "right" : "down"}.svg`).size(11).text_color(t.dim)))
      .child(div().text_size(12).font_semibold().child(LANE_NAMES[lane.status]))
      .child(div().text_size(11).text_color(t.dim).child(String(lane.cards.length)));
  }

  chips(t) {
    const open = this.tasks.filter((x) => x.status !== "COMPLETE");
    const keys = [...new Set(open.map((x) => x.project))].sort();
    if (keys.length < 2) return null;
    const chip = (value, label) => div().id(`project-${value ?? "all"}`).flex_none().px(8).py(2).rounded(10).text_size(11).cursor_pointer()
      .border_1().border_color(this.filter === value ? t.accent : t.border).text_color(this.filter === value ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.filter = value; cx.notify(); }).child(label);
    // Wrapping, not scrolling: a scroll container takes the free space the lanes need.
    return h_flex().id("projects").flex_none().flex_wrap().gap(6).px(10).pb(8)
      .child(chip(null, "All")).children(keys.map((k) => chip(k, k)));
  }

  render(cx) {
    if (props()?.role === "detail") return this.renderDetail(cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const board = lanes(this.tasks, { project: this.filter, query: this.query });
    const open = board.lanes.reduce((n, l) => n + l.cards.length, 0);
    const wide = this.width >= WIDE;
    const note = this.error || (!this.project && this.loading ? "Loading tasks…" : null);
    const body = wide
      ? h_flex().flex_1().min_h(0).items_stretch().gap(10).px(10).pb(10).children(board.lanes.map((lane) => v_flex().flex_1().min_w(0).min_h(0).gap(6)
        .child(this.laneHeader(lane, t, false))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id(`cards-${lane.status}`).absolute().inset_0().overflow_y_scroll().gap(6).children(lane.cards.map((c) => this.card(c, t))))
          .child(Scrollbar.vertical(`cards-${lane.status}`).absolute().inset_0()))))
      : div().flex_1().min_h(0).relative()
        .child(v_flex().id("lanes").absolute().inset_0().overflow_y_scroll().px(10).pb(10).gap(6).children(board.lanes.flatMap((lane) => [
          this.laneHeader(lane, t, true),
          ...(this.collapsed.has(lane.status) ? [] : lane.cards.map((c) => this.card(c, t))),
        ])))
        .child(Scrollbar.vertical("lanes").absolute().inset_0());
    return v_flex().id("trail-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Tasks"))
        .when(Boolean(this.project), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.project.root.split("/").pop())))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.muted).child(`${open} open`))
        .when(board.complete > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${board.complete} complete`))))
      .child(div().flex_none().mx(10).my(8).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(this.chips(t)), (e) => e.child(this.chips(t)))
      .when(Boolean(note), (e) => e.child(div().px(14).py(8).text_color(t.dim).child(note)))
      .when(!note, (e) => e.child(body));
  }

  // The detail dialog.

  initDetail(cx) {
    this.handle.focus();
    const { root, on, key: taskKey } = props();
    cx.spawn(async (cx) => {
      try {
        const sh = shell(on);
        const [task, tasks] = await Promise.all([readTask(sh, root, taskKey), readTasks(sh, root)]);
        this.task = task;
        this.children = tasks.filter((x) => x.parent === taskKey).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  renderDetail() {
    const t = theme(), p = props(), task = this.task;
    const fact = (label, value) => (value ? h_flex().gap(4).text_size(11).child(div().text_color(t.dim).child(label)).child(div().text_color(t.foreground).child(value)) : null);
    const facts = task ? [
      fact("status", task.status), fact("priority", task.priority), fact("kind", task.kind), fact("assignee", task.assignee),
      fact("reporter", task.reporter), fact("parent", task.parent), fact("depends on", task.dependsOn?.join(", ")),
      fact("blocked by", task.blockedBy?.join(", ")), fact("related", task.related?.join(", ")),
      fact("updated", task.updatedAt?.slice(0, 10)),
    ].filter(Boolean) : [];
    return v_flex().id("trail-detail").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(p.overlay); })
      .child(h_flex().gap(8).items_center()
        .child(div().font_family(mono()).text_size(12).text_color(t.dim).child(p.key))
        .child(div().flex_1().min_w(0).font_semibold().whitespace_normal().child(task?.title ?? "")))
      .when(Boolean(this.error), (e) => e.child(div().text_color(t.blocked).child(this.error)))
      .when(!task && !this.error, (e) => e.child(div().text_color(t.dim).child("…")))
      .when(Boolean(task), (e) => e
        .child(h_flex().flex_wrap().gap_x(12).gap_y(4).children(facts))
        .child(div().flex_1().min_h(0).relative().border_t(1).border_color(t.border)
          .child(v_flex().id("detail-body").absolute().inset_0().overflow_y_scroll().pt(10).gap(10)
            .child(task.description ? TextView.markdown(`desc-${p.key}`, task.description) : div().text_color(t.dim).child("No description."))
            .when(this.children.length > 0, (e) => e.child(v_flex().gap(4)
              .child(div().text_size(12).font_semibold().child("Subtasks"))
              .children(this.children.map((s) => h_flex().gap(8).text_size(12)
                .child(div().font_family(mono()).text_color(t.dim).child(s.key))
                .child(div().text_size(10).text_color(s.status === "COMPLETE" ? t.ansi2 : t.muted).child(s.status))
                .child(div().flex_1().min_w(0).truncate().child(s.title)))))))
          .child(Scrollbar.vertical("detail-body").absolute().inset_0())))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("esc close"));
  }
}

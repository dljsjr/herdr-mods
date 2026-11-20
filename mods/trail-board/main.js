// trail-board: the Trail tasks of the focused folder's project as a board.
// board.js reads and writes them through the trail CLI. Lanes stack as
// sections in a narrow panel and stand side by side when it is wide. Click a
// card for its details and right-click it for its menu; + makes a task. This
// mod draws those too, as overlays with props { role: "detail" | "menu" |
// "create", root, on, ... }. Drag a card to another lane to change its status.
// Changes made elsewhere (an agent, the CLI) show as a notification.
//
// Keys, once the board has the keyboard (click it, or pane.go: it is
// focusable): arrows (or h j k l) select a card, Enter opens it, m opens its
// menu, Shift+Left/Right moves it a lane, n makes a task, / searches, Esc
// clears. keys.json can bind trail-board.new and trail-board.focus.
//
// location() follows defaults/mods/changes in herdr-app 0.1.12
// (https://github.com/herdrdev/herdr-app), licensed under the Apache License,
// Version 2.0. See LICENSE-Apache-2.0.txt beside this file.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, ScrollHandle, TextView, Textarea, TextareaState } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, openOverlay, closeOverlay, shared, setShared, notify, nextCommand } from "herdr";
import { ASSIGNEES, PRIORITIES, STATUSES, STATUS_NAMES, act, changes, createTask, findProject, keyOrder, lanes, menuItems, neighbor, readTask, readTasks, tasksDir } from "./board.js";

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
const priorityColor = (t, p) => (p === "HIGH" ? t.ansi1 : p === "MEDIUM" ? t.ansi3 : t.dim);
// Changes inside a repo's own records don't change tasks.
const META = /\/\.(git|jj)(\/|$)/;
// A write from any copy (a menu, a dialog) lands here, so every board showing
// that project refreshes at once: a remote machine has no folder watch.
const WROTE = "trail-board.wrote";
const wrote = (root, keys) => setShared(WROTE, { root, keys, at: Date.now() });
// A board doesn't announce a change it made itself for this long.
const OWN_MS = 15000;
// The last notice, so several boards on one project post it once.
const NOTICED = "trail-board.noticed";
const DRAG_PX = 5;
// An overlay that closes gives the keyboard back to the board that opened
// it, if that board had it then; not when a click beside it closed it, since
// that click put the keyboard where it wanted it.
const CLOSED = "trail-board.closed";

function openCreate({ root, on, projects, project, parent = null, from = null }) {
  openOverlay({ mod: "trail-board", kind: "dialog", width: 520, height: 480, props: { role: "create", root, on, projects, project, parent, from } });
}

export default class TrailBoard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.role === "detail") return this.initDetail(cx);
    if (props()?.role === "menu") return this.initMenu(cx);
    if (props()?.role === "create") return this.initCreate(cx);
    this.seenWrite = shared(WROTE)?.at;
    this.id = `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.tasks = []; this.project = null; this.filter = null; this.query = ""; this.width = 0;
    this.collapsed = new Set(); // lanes a narrow board folds
    this.found = new Map(); // folder -> its trail project, once looked up
    this.search = InputState.new({ placeholder: "Search tasks" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.search.on("focus", () => { this.typing = true; });
    this.search.on("blur", () => { this.typing = false; });
    this.own = new Map(); // key -> when this board's write changed it
    this.selected = null; // the keyboard's card
    this.press = null; // a card pressed, and whether it has moved into a drag
    this.over = null; // the lane a drag is over
    this.listScroll = ScrollHandle.new();
    this.laneScroll = Object.fromEntries(STATUSES.map((s) => [s, ScrollHandle.new()]));
    this.ticks = 0;
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command === "new") this.newTask();
        cx.notify();
      }
    });
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
        if (this.project?.root === project.root) this.announce(this.tasks, tasks, project.root);
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

  // Posts what changed since the last read, leaving out this board's own writes.
  announce(before, after, root) {
    const now = Date.now();
    for (const [k, at] of this.own) if (now - at > OWN_MS) this.own.delete(k);
    const lines = changes(before, after).filter((c) => !this.own.has(c.key)).map((c) => c.text);
    if (!lines.length) return;
    const signature = `${root}\n${lines.join("\n")}`, last = shared(NOTICED);
    if (last?.signature === signature && now - last.at < 5000) return;
    setShared(NOTICED, { signature, at: now });
    const name = root.split("/").pop();
    notify(lines.length === 1
      ? { title: lines[0], body: name, level: "info" }
      // The toast shows the body on one line and cuts it where it must.
      : { title: `${lines.length} task changes in ${name}`, body: lines.join(" \u00b7 "), level: "info" });
  }

  // A drag or Shift+arrow: the card moves at once, and back if trail refuses.
  move(cardKey, status, cx) {
    const { root } = this.project, on = this.on ?? null;
    this.tasks = this.tasks.map((x) => (x.key === cardKey ? { ...x, status } : x));
    this.own.set(cardKey, Date.now());
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await act(shell(on), root, cardKey, { op: "status", value: status });
        wrote(root, [cardKey]);
      } catch (e) {
        notify({ title: `Couldn't move ${cardKey}`, body: String(e.message ?? e), level: "error" });
        this.refresh(cx);
      }
    });
  }

  dragOver(e, status, cx) {
    const p = this.press;
    if (!p) return;
    if (!p.moved) {
      if (Math.hypot(e.position.x - p.x, e.position.y - p.y) < DRAG_PX) return;
      p.moved = true;
    }
    if (this.over !== status || !p.shown) { this.over = status; p.shown = true; cx.notify(); }
  }

  drop(status, cx) {
    const p = this.press;
    if (!p?.moved || p.dropped) return;
    p.dropped = true;
    if (status !== p.status) this.move(p.key, status, cx);
  }

  endDrag(cx) {
    if (!this.press) return;
    const shown = this.press.moved;
    this.press = null; this.over = null;
    if (shown) cx.notify();
  }

  dropTarget(el, status) {
    return el.on_mouse_move((e, cx) => this.dragOver(e, status, cx)).on_mouse_up("left", (_e, cx) => this.drop(status, cx));
  }

  // The keyboard's lanes: a folded lane's cards can't be selected.
  walkable(board) {
    return board.lanes.map((l) => (this.width < WIDE && this.collapsed.has(l.status) ? { ...l, cards: [] } : l));
  }

  // Scrolls the selected card into view: a wide board scrolls each lane, a
  // narrow one scrolls one list of lane headers and cards.
  reveal(board) {
    if (this.width >= WIDE) {
      for (const lane of board.lanes) {
        const i = lane.cards.findIndex((c) => c.key === this.selected);
        if (i >= 0) this.laneScroll[lane.status].scroll_to_item(i);
      }
      return;
    }
    let index = 0;
    for (const lane of board.lanes) {
      index++;
      if (this.collapsed.has(lane.status)) continue;
      const i = lane.cards.findIndex((c) => c.key === this.selected);
      if (i >= 0) return this.listScroll.scroll_to_item(index + i);
      index += lane.cards.length;
    }
  }

  onKey(e, cx) {
    if (this.typing) {
      if (e.key === "escape" || e.key === "down") { this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
    const board = lanes(this.tasks, { project: this.filter, query: this.query });
    const card = board.lanes.flatMap((l) => l.cards).find((c) => c.key === this.selected);
    const dir = { up: "up", down: "down", left: "left", right: "right", k: "up", j: "down", h: "left", l: "right" }[e.key];
    if (dir && e.modifiers.shift && (dir === "left" || dir === "right")) {
      const status = card && STATUSES[STATUSES.indexOf(card.status) + (dir === "left" ? -1 : 1)];
      if (status) this.move(card.key, status, cx);
    } else if (dir) {
      this.selected = neighbor(this.walkable(board), card ? card.key : null, dir);
      this.reveal(board);
    } else if (e.key === "enter" && card) this.openCard(card);
    else if (e.key === "m" && card) this.openMenu(card);
    else if (e.key === "n") this.newTask();
    else if (e.key === "/" || e.key_char === "/") this.search.focus();
    else if (e.key === "escape") {
      if (this.query) { this.search.set_value(""); this.query = ""; } else this.selected = null;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  openCard(card) {
    openOverlay({ mod: "trail-board", kind: "dialog", width: 680, height: 0.8, props: { role: "detail", root: this.project.root, on: this.on ?? null, key: card.key, from: this.from() } });
  }

  openMenu(card) {
    const { key, title, status, assignee, priority, kind, project } = card;
    openOverlay({ mod: "trail-board", kind: "popup", width: 240, height: 460, props: { role: "menu", root: this.project.root, on: this.on ?? null, task: { key, title, status, assignee, priority, kind, project }, from: this.from() } });
  }

  newTask() {
    if (!this.project) return;
    const projects = [...new Set([...this.tasks.map((x) => x.project), ...this.project.projects.map((p) => p.key)])].sort();
    openCreate({ root: this.project.root, on: this.on ?? null, projects, project: this.filter ?? projects[0] ?? "", from: this.from() });
  }

  // Who gets the keyboard back when an overlay this board opens closes.
  from() {
    return this.handle.is_focused() ? this.id : null;
  }

  card(c, t) {
    const done = c.subtasks ? `${c.subtasks.done}/${c.subtasks.total} subtasks` : null;
    const assignee = c.assignee && c.assignee !== "UNASSIGNED" ? c.assignee : null;
    const card = h_flex().id(`card-${c.key}`).flex_none().w_full().rounded(8).overflow_hidden().border_1()
      .border_color(this.selected === c.key ? t.accent : t.border).bg(t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .when(Boolean(this.press?.moved) && this.press.key === c.key, (e) => e.opacity(0.4))
      // A press becomes a drag once it moves; one that doesn't is a click.
      .on_mouse_down("left", (e) => { this.press = { key: c.key, status: c.status, x: e.position.x, y: e.position.y, moved: false, fresh: true }; })
      .on_mouse_up("left", (_e, cx) => {
        if (this.press?.key !== c.key || this.press.moved) return;
        this.selected = c.key; cx.notify();
        this.openCard(c);
      })
      .on_mouse_down("right", (_e, cx) => { this.selected = c.key; cx.notify(); this.openMenu(c); })
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
    return this.dropTarget(card, c.status);
  }

  // Whether a drag is over `status`, a lane it would move its card to.
  dropping(status) {
    return Boolean(this.press?.moved) && this.over === status && this.press.status !== status;
  }

  laneHeader(lane, t, foldable) {
    const shut = foldable && this.collapsed.has(lane.status);
    return this.dropTarget(h_flex().id(`lane-${lane.status}`), lane.status).h(28).flex_none().px(4).gap(6).items_center().rounded(6)
      .border_1().border_color(foldable && this.dropping(lane.status) ? t.accent : t.background)
      .when(foldable, (e) => e.cursor_pointer().on_click((_e, cx) => { shut ? this.collapsed.delete(lane.status) : this.collapsed.add(lane.status); cx.notify(); }))
      .when(foldable, (e) => e.child(svg(`mods/workspace-chrome/chevron-${shut ? "right" : "down"}.svg`).size(11).text_color(t.dim)))
      .child(div().text_size(12).font_semibold().child(STATUS_NAMES[lane.status]))
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
    if (props()?.role === "menu") return this.renderMenu(cx);
    if (props()?.role === "create") return this.renderCreate(cx);
    if (key() !== this.context) this.refresh(cx);
    const back = shared(CLOSED);
    if (back?.from === this.id && back.at !== this.seenBack) {
      this.seenBack = back.at;
      // focus() can't run during render: a timer runs it right after.
      cx.timer.after(0, () => this.handle.focus());
    }
    const write = shared(WROTE);
    if (write && write.at !== this.seenWrite) {
      this.seenWrite = write.at;
      if (write.root === this.project?.root) {
        for (const k of write.keys ?? []) this.own.set(k, Date.now());
        this.refresh(cx);
      }
    }
    const t = theme();
    const board = lanes(this.tasks, { project: this.filter, query: this.query });
    const open = board.lanes.reduce((n, l) => n + l.cards.length, 0);
    const wide = this.width >= WIDE;
    const note = this.error || (!this.project && this.loading ? "Loading tasks…" : null);
    const body = wide
      ? h_flex().flex_1().min_h(0).items_stretch().gap(10).px(10).pb(10).children(board.lanes.map((lane) => this.dropTarget(v_flex().id(`column-${lane.status}`), lane.status)
        .flex_1().min_w(0).min_h(0).gap(6).rounded(8).border_1().border_color(this.dropping(lane.status) ? t.accent : t.background)
        .child(this.laneHeader(lane, t, false))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id(`cards-${lane.status}`).absolute().inset_0().overflow_y_scroll().track_scroll(this.laneScroll[lane.status]).gap(6).children(lane.cards.map((c) => this.card(c, t))))
          .child(Scrollbar.vertical(`cards-${lane.status}`).absolute().inset_0()))))
      : div().flex_1().min_h(0).relative()
        .child(v_flex().id("lanes").absolute().inset_0().overflow_y_scroll().track_scroll(this.listScroll).px(10).pb(10).gap(6).children(board.lanes.flatMap((lane) => [
          this.laneHeader(lane, t, true),
          ...(this.collapsed.has(lane.status) ? [] : lane.cards.map((c) => this.card(c, t))),
        ])))
        .child(Scrollbar.vertical("lanes").absolute().inset_0());
    return v_flex().id("trail-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      // A card's press runs first and marks itself fresh; any other press
      // clears one left from a drag released outside the board, which
      // reports no release here.
      .on_mouse_down("left", () => {
        this.handle.focus();
        if (this.press?.fresh) this.press.fresh = false; else this.press = null;
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered && this.over) { this.over = null; cx.notify(); } })
      .when(Boolean(this.press?.moved), (e) => e.cursor_grabbing())
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Tasks"))
        .when(Boolean(this.project), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.project.root.split("/").pop())))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.muted).child(`${open} open`))
        .when(board.complete > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${board.complete} complete`)))
        .when(Boolean(this.project), (e) => e.child(div().id("new-task").size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.newTask())
          .child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(div().flex_none().mx(10).my(8).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(this.chips(t)), (e) => e.child(this.chips(t)))
      .when(Boolean(note), (e) => e.child(div().px(14).py(8).text_color(t.dim).child(note)))
      .when(!note, (e) => e.child(body));
  }

  async close() {
    const from = props()?.from;
    if (from && !this.away && !this.handedOff) setShared(CLOSED, { from, at: Date.now() });
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
        this.children = tasks.filter((x) => x.parent === taskKey).sort(keyOrder);
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
    return v_flex().id("trail-detail").track_focus(this.handle).on_mouse_down_out(() => { this.away = true; }).size_full().p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
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

  // The card menu.

  initMenu() {
    this.handle.focus();
    this.at = 0;
  }

  chooseMenu(item, cx) {
    const p = props();
    if (this.busy) return;
    if (item.op === "subtask") {
      this.handedOff = true;
      closeOverlay(p.overlay);
      openCreate({ root: p.root, on: p.on, projects: [p.task.project], project: p.task.project, parent: { key: p.task.key, title: p.task.title }, from: p.from });
      return;
    }
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await act(shell(p.on), p.root, p.task.key, item);
        wrote(p.root, [p.task.key]);
        closeOverlay(p.overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  renderMenu() {
    const t = theme(), p = props(), items = menuItems(p.task);
    return v_flex().id("trail-menu").track_focus(this.handle).on_mouse_down_out(() => { this.away = true; }).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") return this.chooseMenu(items[this.at], cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`${p.task.key} \u00b7 ${p.task.title}`))
      .children(items.map((item, i) => v_flex()
        .when(i > 0 && items[i - 1].group !== item.group, (e) => e.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`tm-${i}`).h(28).px(8).rounded(7).items_center().cursor_pointer()
          .when(i === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.chooseMenu(item, cx))
          .child(div().flex_1().child(item.label)))))
      .when(this.busy, (e) => e.child(div().px(8).py(6).text_size(11).text_color(t.dim).child("Working\u2026")))
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(6).text_size(11).text_color(t.blocked).whitespace_normal().child(this.error)));
  }

  // The create dialog.

  initCreate() {
    const p = props();
    this.fields = { project: p.project, kind: p.parent ? "SUBTASK" : "TASK", priority: "MEDIUM", assignee: "UNASSIGNED" };
    this.title = InputState.new({ placeholder: p.parent ? "Subtask title" : "Task title" });
    this.title.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.title.on("submit", (_e, cx) => this.create(cx));
    this.desc = TextareaState.new({ placeholder: "Description, in Markdown (optional)", rows: 7 });
    this.title.focus();
  }

  create(cx) {
    const p = props(), title = this.title.value().trim();
    if (this.busy || !title || !this.fields.project) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const key = await createTask(shell(p.on), p.root, { ...this.fields, title, parent: p.parent?.key ?? null, description: this.desc.value() });
        wrote(p.root, [key, ...(p.parent ? [p.parent.key] : [])]);
        closeOverlay(p.overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }

  renderCreate() {
    const t = theme(), p = props(), f = this.fields;
    const lower = (v) => v.toLowerCase();
    const chips = (field, values, label = (v) => v) => h_flex().flex_wrap().gap(6).children(values.map((v) => div().id(`${field}-${v}`)
      .px(9).py(3).rounded(10).text_size(12).cursor_pointer().border_1().border_color(f[field] === v ? t.accent : t.border)
      .text_color(f[field] === v ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { f[field] = v; cx.notify(); }).child(label(v))));
    const field = (name, el) => h_flex().gap(10).items_center().child(div().w(64).flex_none().text_size(11).text_color(t.dim).child(name)).child(el);
    const ready = !this.busy && Boolean(f.project) && Boolean(this.title.value().trim());
    const button = (id, label, solid, action) => div().id(id).h(28).px(14).flex().items_center().rounded(6).text_size(12)
      .bg(solid ? (ready ? t.solid : t.raised) : t.raised).text_color(solid ? (ready ? t.solid_foreground : t.dim) : t.foreground)
      .when(!solid || ready, (e) => e.cursor_pointer().on_click(action)).child(label);
    return v_flex().id("trail-create").track_focus(this.handle).on_mouse_down_out(() => { this.away = true; }).size_full().p(16).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(p.overlay); })
      .child(v_flex().gap(2)
        .child(div().font_semibold().child(p.parent ? `New subtask of ${p.parent.key}` : "New task"))
        .when(Boolean(p.parent), (e) => e.child(div().text_size(12).text_color(t.muted).truncate().child(p.parent.title))))
      .child(div().id("create-title").h(32).flex_none().px(10).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.title.focus(); })
        .child(Input.new(this.title).h_full().text_size(13).text_color(t.foreground)))
      .when(!p.parent, (e) => e
        .child(field("Project", p.projects.length ? chips("project", p.projects) : div().text_size(12).text_color(t.dim).child("No projects yet: make one with trail project create.")))
        .child(field("Kind", chips("kind", ["TASK", "BUG"], lower))))
      .child(field("Priority", chips("priority", PRIORITIES, lower)))
      .child(field("Assignee", chips("assignee", ASSIGNEES, lower)))
      .child(div().id("create-desc").flex_1().min_h(0).px(10).py(6).rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.desc.focus(); })
        .child(Textarea.new(this.desc).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.blocked).whitespace_normal().child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(this.busy ? "Creating\u2026" : "\u21b5 create \u00b7 esc cancel"))
        .child(button("create-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("create-ok", "Create", true, (_e, cx) => this.create(cx))));
  }
}

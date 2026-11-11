# herdr-mods

Personal mods and layouts for the [Herdr](https://herdr.dev) desktop app. The
repo mirrors the app home (`~/.config/herdr-app`): mods live in `mods/<name>/`,
layouts in `layouts/<name>.json`.

## Mods

- **jj-changes**: the Changes panel for jj and git. It lists, in one list, the
  changed files of the repo containing the focused folder and of every repo
  below it, including repos in folders the outer repo ignores, so changes an
  agent makes from a workbench root show up. It doesn't look inside nested
  repos for further repos, and stops after 50 repos. For a jj repo a file is
  changed in `@`; for git, against `HEAD` or untracked. The message box acts on
  the selected file's repo, named above it: for jj it starts with that repo's
  `@` description, **Describe** sets it and the arrow offers **Commit**
  (`jj commit`); for git, **Commit** runs `git add -A` and `git commit`. With
  more than one repo, the layers button in the header groups the list by
  repository, one collapsible section per repo; the choice is remembered. On
  Linux, Herdr doesn't watch ignored folders, so changes there show on the next
  minute's refresh.
- **jj-graph**: the `jj log` graph of the focused workspace, in jj's order and
  your `revsets.log`, drawn as colored lanes, one per line of descent, with or
  without bookmarks. A dashed line runs through changes the revset hides, as
  jj's "(elided revisions)" does; a short dashed stub ends a line with nothing
  shown below it. The field above it takes any revset, applied with Enter
  and remembered per repo until Herdr restarts; empty means `revsets.log`. It
  shows at most 500 changes. Right-click a change to edit it,
  start a new change on top, start a new workspace from it, squash it into its
  parent, or abandon it. Squash keeps both descriptions instead of opening an
  editor.
- **jj-workspaces**: the dialog that creates, opens and removes jj
  workspaces. A new workspace starts from `trunk()`, or from the change it was
  opened on in jj-graph, in
  `~/.herdr/jj-workspaces/<repo>/<name>`. Removing one deletes its folder;
  jj snapshots it first, so its tracked changes stay in history.
- **jj-spaces**: the sidebar. A space in a jj workspace shows its bookmarks or
  `@<change>`, `↑`/`↓` against the tracked remote, `!` for a conflict, `?` for
  a bookmark that was never pushed, and `*N` for N changed files. A jj
  workspace sits under its repo's main workspace. Other Git repos look as
  they do in Herdr's sidebar. Right-click opens jj-menu.
- **trail-board**: the Trail tasks of the focused
  folder's project, from `trail` on your PATH. Lanes for Not started, In
  progress and Needs review stack in the side panel and stand side by side
  when the panel is wide or the board has a tab of its own. Cards show the
  key, title, priority, a bug badge, assignee, subtasks done and blockers;
  subtasks count on their parent rather than getting cards. Filter by project
  or search; click a card for its description and subtasks. Open it from the
  Tasks button, or as a tab:

  ```sh
  herdr-app do tab.new '{"name":"Tasks","mod":"trail-board"}'
  ```

- **jj-menu**, **jj-new-menu**, **jj-tabs**: the space right-click menu and
  the tab bar's `+` menu, with New, Open and Remove jj workspace where Herdr
  has its Git worktree items. In a git repo they keep Herdr's worktree items.
  jj-tabs also has the Graph and Tasks buttons.

Inside a git repo nested in a jj repo, every mod treats the folder as git: the
innermost repo wins.

The sidebar never snapshots: a workspace's `*N` updates after any jj command
runs there, or on its own if jj's watchman snapshot trigger is on.

All but jj-changes started as copies of Herdr's own mods (Apache-2.0); each
says what it changed at the top of its `main.js`. Herdr won't update them.

## Layouts

- **jj**: Herdr's `main` layout (from herdr-app 0.1.12) with jj-spaces,
  jj-tabs and jj-changes in place of Herdr's sidebar, tab bar and Changes
  panel, and jj-graph and trail-board as further side panels. Herdr won't update this copy when `main` changes. Switch to it with
  the layout picker, or:

  ```sh
  herdr-app do layout.switch '{"name":"jj"}'
  ```

## Install

```sh
./install.sh status     # compare installed mods and layouts with this repo
./install.sh install    # install new ones, upgrade older ones
./install.sh uninstall  # remove what this script installed
```

Each command works on everything in `mods/` and `layouts/`, or only on the items
you name, such as `mods/jj-changes` or `layouts/jj`. Add `--app-home DIR` to
target another app home. The default is `$HERDR_APP_HOME`, then
`~/.config/herdr-app`.

The installer runs `herdr-app check` on every mod before it changes anything.
It refuses to:

- overwrite a mod or layout it did not install
- replace or remove files you edited in the installed copy
- downgrade an item to an older version

`--force` allows the last two. It never touches anything it did not install.

If a running Herdr window shows a layout that `uninstall` removes, the installer
switches that window to `main` first.

## Versions

Each mod has a `VERSION` file holding `MAJOR.MINOR.PATCH`; each layout has a
`layouts/<name>.VERSION` file. Raise it when a change should count as an
upgrade. If you change an item without raising it, `install` still copies the
change and notes that the version did not change.

## Development

Tools are pinned in `mise.toml`.

```sh
mise run test   # bun test
mise run lint   # shellcheck
```

## License

MIT (see `LICENSE`), except for code derived from the
[Herdr app](https://github.com/herdrdev/herdr-app), which stays under the
Apache License, Version 2.0:

- the `main.js` of jj-changes, jj-graph, jj-menu, jj-new-menu, jj-spaces,
  jj-tabs and jj-workspaces, each of which says at the top what it was derived
  from and what changed; a copy of the Apache license sits in each of those
  mod folders
- the `location()` helper in trail-board's `main.js`, taken from Herdr's
  Changes panel; trail-board's folder has a copy of the Apache license too
- `layouts/jj.json`, a copy of Herdr's `main` layout with its Changes, sidebar
  and tab bar blocks pointed at these mods and a Graph panel added

jj-graph's `lanes.js` follows the approach of
[herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph) (MIT).

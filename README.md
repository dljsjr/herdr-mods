# herdr-mods

Personal mods and layouts for the [Herdr](https://herdr.dev) desktop app. The
repo mirrors the app home (`~/.config/herdr-app`): mods live in `mods/<name>/`,
layouts in `layouts/<name>.json`.

## Mods

- **jj-changes**: the Changes panel for jj repos. It shows the diff of `@`
  against its parent, and its message box starts with the description of `@`.
  **Describe** sets that description; the arrow beside it offers **Commit**
  (`jj commit`).

## Layouts

- **jj**: Herdr's `main` layout (from herdr-app 0.1.12) with jj-changes in
  place of the Changes panel, so the Changes button opens it. Herdr won't
  update this copy when `main` changes. Switch to it with the layout picker,
  or:

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

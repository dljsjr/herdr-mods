# herdr-mods

Personal mods for the [Herdr](https://herdr.dev) desktop app. The layout mirrors
the app home (`~/.config/herdr-app`): mods live in `mods/<name>/`, layouts in
`layouts/<name>.json`.

## Install

```sh
./install.sh status     # compare installed mods with this repo
./install.sh install    # install new mods, upgrade older ones
./install.sh uninstall  # remove mods this script installed
```

Each command works on every mod in `mods/`, or only on the mods you name. Add
`--app-home DIR` to target another app home. The default is `$HERDR_APP_HOME`,
then `~/.config/herdr-app`.

The installer runs `herdr-app check` on every mod before it changes anything.
It refuses to:

- overwrite a mod folder it did not install
- replace or remove files you edited in the installed copy
- downgrade a mod to an older version

`--force` allows the last two. It never touches a folder it did not install.

## Versions

Each mod has a `VERSION` file holding `MAJOR.MINOR.PATCH`. Raise it when a change
should count as an upgrade. If you change a mod without raising it, `install`
still copies the change and notes that the version did not change.

## Development

Tools are pinned in `mise.toml`.

```sh
mise run test   # bun test
mise run lint   # shellcheck
```

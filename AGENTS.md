# herdr-mods

Personal mods and layouts for the Herdr desktop app (`herdr-app`). A mod is trusted JavaScript run by the app's gpui-kit runtime. It has no Node APIs, no DOM and no `setTimeout`. This is a colocated jj repository, so use `jj`, not `git`.

## Before mod work

- Read the installed app guide at `$HERDR_APP_HOME/AGENTS.md` (default `~/.config/herdr-app/AGENTS.md`) and `herdr.d.ts` beside it. Also run `herdr-app --skill` and `hc --skill`.
- Search `gpui-kit.d.ts` when you need it. Do not read all 22,000 lines.
- The shipped mods in the app home are reference code (Apache-2.0). Never edit them in place. A fork in this repo keeps the attribution and says what changed.
- When Herdr updates, backport fixes worth having into our forks; exact tracking isn't the goal. Merge with `diff3 -m <our fork> <old upstream> <new upstream>`, using the upstream copies saved in `.sandpiper/docs/upstream-base/<version>/`, then save the new upstream copies there.

## Layout

The repo mirrors the app home: mods go in `mods/<name>/` and layouts in `layouts/<name>.json`. Mods are installed by copying into an app home with `./install.sh`, never by symlinking. Run `./install.sh` with no arguments for its usage.

Every mod has a `VERSION` file holding `MAJOR.MINOR.PATCH`, and every layout has a `layouts/<name>.VERSION` file. Raise it when a change should count as an upgrade. The installer writes a hidden `.herdr-mods` manifest into each installed mod, and a `layouts/.<name>.herdr-mods` file beside each installed layout. The manifest records the version and file hashes, so the installer can tell an older install, a newer one or a locally edited one. Do not edit or delete a manifest by hand. Manifests already installed must stay readable: change the manifest format only with a new `format` number and code that reads the old one.

`layouts/jj.json` is a `layout.clone` of `main` with one change. To change it, edit that file directly; don't regenerate it from a newer `main` unless that's the task.

Tools are pinned in `mise.toml`. Run `mise run test` (bun test) and `mise run lint` (shellcheck) after changing `install.sh` or any mod's jj code.

A mod cannot import from outside its own folder (`herdr-app check` rejects it). Code shared by the jj mods lives in `jj-repo.js`, copied into each mod that needs it; `tests/shared.test.js` fails when the copies differ. Doug's call (2026-11-02): copying is fine for now; consider a bundler if the shared code grows. Keep jj commands and output parsing in plain modules with no Herdr imports, and test them against real jj repos.

`tests/trail-board.test.js` runs `trail` from PATH against temporary task folders.

Tests run jj with `tests/jj-config.toml`, not the person's config: their watchman snapshot trigger would race the tests and leave watches on deleted folders. `Bun.spawnSync` keeps the environment the process started with, so every spawn in the tests passes `{ env: process.env }`. Register `afterEach(removeTempDirs)` in each test file that uses `tests/jj-helpers.js`.

## Test in a scratch window, never the live app

Never install, reload or experiment with mods against the person's running Herdr window or core. Use a scratch window with its own app home and core:

1. Create `<scratch>/app-home/shared.json` containing `{"frame.welcomed":"skipped"}`. Also create `<scratch>/app-home/update-notes.json` containing `{"last_run":"<v>","presented":["<v>"]}`, where `<v>` is the version from `herdr-app --version`. Without them, a welcome dialog or a What's new window covers the window, and `overlay.close` cannot dismiss either.
2. Install mods: `./install.sh install --app-home <scratch>/app-home`. This also works while the window runs; the app reloads the mod.
3. Launch it as a background process: `env HERDR_APP_HOME=<scratch>/app-home HC_SESSION=<name> HERDR_TELEMETRY=0 herdr-app`. If an earlier scratch window is still quitting, the new launch hands off to it and exits at once, so wait for the old process to end.
4. Drive it with the same `HERDR_APP_HOME` and `HC_SESSION`: `herdr-app status`, `ls`, `do`, `shot`. Open a mod with `space.new`, then `pane.split {mod, direction}`. New mod folders are not docked automatically. To see the jj layout's Changes panel, run `layout.switch {name: "jj"}`, `layout.show {id: "panel"}`, then `layout.select {stack: "panel-body", child: "changes"}`. The CLI cannot click inside a mod.
5. Clean up: `herdr-app do app.quit`, then `hc server stop` with the same `HC_SESSION`, then delete `<scratch>`.

Do not set `XDG_STATE_HOME`. Shells in the scratch window inherit it and leave stray daemons such as watchman behind. `HC_SESSION` alone separates the core's state.

`herdr-app shot` saves the last frame the window drew. A scratch window behind other windows can stop drawing, so every shot repeats an old frame. If two shots taken after a visible change are identical, relaunch the scratch window before trusting a screenshot.

In a `v_virtual_list`, the row renderer can't attach handlers: `on_click` and the rest throw there, and the list draws nothing, without an error in `herdr-app status`. Use the list's `on_item_click` and `on_item_secondary_click`, which get the row's key.

For `window.paint_path`, give `PathBuilder` coordinates as percentages of the painted bounds. Pixel coordinates don't scale with Herdr's zoom the way element sizes do, so lines drift off the elements they should meet.

After every mod change, run `herdr-app check <mod folder>`. Then install it into the scratch app home, run `status` and `shot` against the scratch window, and look at the picture.

## Internal context

Planning docs (`.sandpiper/docs/`), tasks (`trail`) and the journal live under `.sandpiper/`, which is not tracked in git.

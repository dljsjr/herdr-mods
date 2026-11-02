# herdr-mods

Personal mods and layouts for the Herdr desktop app (`herdr-app`). A mod is trusted JavaScript run by the app's gpui-kit runtime. It has no Node APIs, no DOM and no `setTimeout`. This is a colocated jj repository, so use `jj`, not `git`.

## Before mod work

- Read the installed app guide at `$HERDR_APP_HOME/AGENTS.md` (default `~/.config/herdr-app/AGENTS.md`) and `herdr.d.ts` beside it. Also run `herdr-app --skill` and `hc --skill`.
- Search `gpui-kit.d.ts` when you need it. Do not read all 22,000 lines.
- The shipped mods in the app home are reference code (Apache-2.0). Never edit them in place. A fork in this repo keeps the attribution and says what changed.

## Layout

The repo mirrors the app home: mods go in `mods/<name>/` and layouts in `layouts/<name>.json`. Mods are installed by copying into an app home with `./install.sh`, never by symlinking. Run `./install.sh` with no arguments for its usage.

Every mod has a `VERSION` file holding `MAJOR.MINOR.PATCH`. Raise it when a change should count as an upgrade. The installer writes a hidden `.herdr-mods` manifest into each installed mod. The manifest records the version and file hashes, so the installer can tell an older install, a newer one or a locally edited one. Do not edit or delete a manifest by hand.

Tools are pinned in `mise.toml`. Run `mise run test` (bun test) and `mise run lint` (shellcheck) after changing `install.sh`.

## Test in a scratch window, never the live app

Never install, reload or experiment with mods against the person's running Herdr window or core. Use a scratch window with its own app home and core:

1. Create `<scratch>/app-home/shared.json` containing `{"frame.welcomed":"skipped"}`. Also create `<scratch>/app-home/update-notes.json` containing `{"last_run":"<v>","presented":["<v>"]}`, where `<v>` is the version from `herdr-app --version`. Without them, a welcome dialog or a What's new window covers the window, and `overlay.close` cannot dismiss either.
2. Install mods: `./install.sh install --app-home <scratch>/app-home`. This also works while the window runs; the app reloads the mod.
3. Launch it as a background process: `env HERDR_APP_HOME=<scratch>/app-home HC_SESSION=<name> HERDR_TELEMETRY=0 herdr-app`. If an earlier scratch window is still quitting, the new launch hands off to it and exits at once, so wait for the old process to end.
4. Drive it with the same `HERDR_APP_HOME` and `HC_SESSION`: `herdr-app status`, `ls`, `do`, `shot`. Open a mod with `space.new`, then `pane.split {mod, direction}`. New mod folders are not docked automatically.
5. Clean up: `herdr-app do app.quit`, then `hc server stop` with the same `HC_SESSION`, then delete `<scratch>`.

Do not set `XDG_STATE_HOME`. Shells in the scratch window inherit it and leave stray daemons such as watchman behind. `HC_SESSION` alone separates the core's state.

After every mod change, run `herdr-app check <mod folder>`. Then install it into the scratch app home, run `status` and `shot` against the scratch window, and look at the picture.

## Internal context

Planning docs (`.sandpiper/docs/`), tasks (`trail`) and the journal live under `.sandpiper/`, which is not tracked in git.

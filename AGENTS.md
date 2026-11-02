# herdr-mods

Personal mods and layouts for the Herdr desktop app (`herdr-app`). A mod is trusted JavaScript run by the app's gpui-kit runtime. It has no Node APIs, no DOM and no `setTimeout`. This is a colocated jj repository, so use `jj`, not `git`.

## Before mod work

- Read the installed app guide at `$HERDR_APP_HOME/AGENTS.md` (default `~/.config/herdr-app/AGENTS.md`) and `herdr.d.ts` beside it. Also run `herdr-app --skill` and `hc --skill`.
- Search `gpui-kit.d.ts` when you need it. Do not read all 22,000 lines.
- The shipped mods in the app home are reference code (Apache-2.0). Never edit them in place. A fork in this repo keeps the attribution and says what changed.

## Layout

The repo mirrors the app home: mods go in `mods/<name>/` and layouts in `layouts/<name>.json`. Mods are installed by copying into an app home, never by symlinking.

## Test in a scratch window, never the live app

Never install, reload or experiment with mods against the person's running Herdr window or core. Use a scratch window with its own app home and core:

1. Create `<scratch>/app-home/shared.json` containing `{"frame.welcomed":"skipped"}`. Without it, a welcome dialog covers the window and `overlay.close` cannot dismiss it.
2. Launch it as a background process: `env HERDR_APP_HOME=<scratch>/app-home HC_SESSION=<name> HERDR_TELEMETRY=0 herdr-app`.
3. Drive it with the same `HERDR_APP_HOME` and `HC_SESSION`: `herdr-app status`, `ls`, `do`, `shot`. Open a mod with `space.new`, then `pane.split {mod}`. New mod folders are not docked automatically.
4. Clean up: `herdr-app do app.quit`, then `hc server stop` with the same `HC_SESSION`, then delete `<scratch>`.

Do not set `XDG_STATE_HOME`. Shells in the scratch window inherit it and leave stray daemons such as watchman behind. `HC_SESSION` alone separates the core's state.

After every mod change, run `herdr-app check <mod folder>`. Then run `status` and `shot` against the scratch window and look at the picture.

## Internal context

Planning docs (`.sandpiper/docs/`), tasks (`trail`) and the journal live under `.sandpiper/`, which is not tracked in git.

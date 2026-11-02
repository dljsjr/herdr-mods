import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "install.sh");
const demoMain = `import { View, div } from "gpui-kit";
export default class Demo extends View {
  render() { return div().child("demo"); }
}
`;

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writeMod(repo, name, { version = "0.1.0", main = demoMain } = {}) {
  const dir = join(repo, "mods", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.js"), main);
  writeFileSync(join(dir, "mod.json"), '{ "place": "none" }\n');
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  return dir;
}

function makeRepo(mods = { demo: {} }, layouts = {}) {
  const repo = tempDir("herdr-mods-repo-");
  cpSync(script, join(repo, "install.sh"));
  for (const [name, options] of Object.entries(mods)) writeMod(repo, name, options);
  for (const [name, options] of Object.entries(layouts)) writeLayout(repo, name, options);
  return repo;
}

const layoutJson = (mod) => `{ "id": "root", "type": "block", "content": { "mod": "${mod}" } }\n`;

function writeLayout(repo, name, { version = "0.1.0", mod = "demo" } = {}) {
  mkdirSync(join(repo, "layouts"), { recursive: true });
  writeFileSync(join(repo, "layouts", `${name}.json`), layoutJson(mod));
  writeFileSync(join(repo, "layouts", `${name}.VERSION`), `${version}\n`);
}

function run(repo, ...args) {
  const result = Bun.spawnSync(["sh", join(repo, "install.sh"), ...args]);
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

describe("install", () => {
  test("copies a new mod and records its version and file hashes", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(0);
    const installed = join(home, "mods", "demo");
    expect(readFileSync(join(installed, "main.js"), "utf8")).toBe(demoMain);
    expect(existsSync(join(installed, "VERSION"))).toBe(false);
    const manifest = readFileSync(join(installed, ".herdr-mods"), "utf8").split("\n");
    expect(manifest).toContain("format=1");
    expect(manifest).toContain("owner=herdr-mods");
    expect(manifest).toContain("mod=demo");
    expect(manifest).toContain("version=0.1.0");
    expect(manifest).toContain(`file=${sha256(demoMain)} main.js`);
    expect(manifest).toContain(`file=${sha256('{ "place": "none" }\n')} mod.json`);
  });

  test("records the jj commit it installed from", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    Bun.spawnSync(["jj", "git", "init", repo]);
    const jj = (...args) => Bun.spawnSync(["jj", "-R", repo, ...args]).stdout.toString();

    run(repo, "install", "--app-home", home);

    const commit = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(home, "mods", "demo", ".herdr-mods"), "utf8")).toContain(`\ncommit=${commit}\n`);
  });

  test("upgrades an older install and drops files the repo no longer has", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    writeFileSync(join(repo, "mods", "demo", "old.js"), "export {};\n");
    run(repo, "install", "--app-home", home);
    rmSync(join(repo, "mods", "demo", "old.js"));
    writeFileSync(join(repo, "mods", "demo", "VERSION"), "0.2.0\n");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: upgraded 0.1.0 -> 0.2.0\n");
    expect(existsSync(join(home, "mods", "demo", "old.js"))).toBe(false);
    expect(run(repo, "status", "--app-home", home).stdout).toBe("mods/demo: same 0.2.0\n");
  });

  test("leaves an up-to-date install untouched", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    const appWritten = join(home, "mods", "demo", "gpui-kit.d.ts");
    writeFileSync(appWritten, "// app types\n");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: up to date 0.1.0\n");
    expect(readFileSync(appWritten, "utf8")).toBe("// app types\n");
  });

  test("reinstalls repo changes made without a version bump", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    const changedMain = demoMain.replace('"demo"', '"demo 2"');
    writeFileSync(join(repo, "mods", "demo", "main.js"), changedMain);

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: reinstalled 0.1.0, repo changed without a version bump\n");
    expect(readFileSync(join(home, "mods", "demo", "main.js"), "utf8")).toBe(changedMain);
    expect(run(repo, "status", "--app-home", home).stdout).toBe("mods/demo: same 0.1.0\n");
  });

  test("installs nothing when any mod fails herdr-app check", () => {
    const repo = makeRepo({ broken: { main: "this is not javascript {{{\n" }, demo: {} });
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mods/broken: herdr-app check failed");
    expect(result.stderr).toContain("nothing was installed");
    expect(existsSync(join(home, "mods", "demo"))).toBe(false);
  });

  test("refuses a foreign folder even with --force and leaves it alone", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    mkdirSync(join(home, "mods", "demo"), { recursive: true });
    writeFileSync(join(home, "mods", "demo", "main.js"), "// someone else's\n");

    const result = run(repo, "install", "--force", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mods/demo: foreign (no .herdr-mods manifest)");
    expect(readFileSync(join(home, "mods", "demo", "main.js"), "utf8")).toBe("// someone else's\n");
  });

  test("refuses to downgrade a newer install unless forced", () => {
    const repo = makeRepo({ demo: { version: "0.2.0" } });
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    writeFileSync(join(repo, "mods", "demo", "VERSION"), "0.1.0\n");

    const refused = run(repo, "install", "--app-home", home);
    const statusAfterRefusal = run(repo, "status", "--app-home", home).stdout;
    const forced = run(repo, "install", "--force", "--app-home", home);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("mods/demo: installed 0.2.0 is newer than repo 0.1.0; --force downgrades");
    expect(statusAfterRefusal).toBe("mods/demo: newer 0.2.0 (repo 0.1.0)\n");
    expect(forced.code).toBe(0);
    expect(forced.stdout).toBe("mods/demo: downgraded 0.2.0 -> 0.1.0\n");
  });

  test("refuses to replace local edits unless forced", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    const installedMain = join(home, "mods", "demo", "main.js");
    writeFileSync(installedMain, "// local edit\n");

    const refused = run(repo, "install", "--app-home", home);
    const editAfterRefusal = readFileSync(installedMain, "utf8");
    const forced = run(repo, "install", "--force", "--app-home", home);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("mods/demo: installed files were edited; --force replaces them");
    expect(editAfterRefusal).toBe("// local edit\n");
    expect(forced.code).toBe(0);
    expect(forced.stdout).toBe("mods/demo: reinstalled 0.1.0, replacing local edits\n");
    expect(readFileSync(installedMain, "utf8")).toBe(demoMain);
  });
});

describe("arguments", () => {
  test.each([
    ["a two-part version", "1.0\n"],
    ["a prefixed version", "v1.0.0\n"],
    ["an empty file", ""],
    ["no file", null],
  ])("rejects a repo mod whose VERSION has %s", (_, content) => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    const versionFile = join(repo, "mods", "demo", "VERSION");
    if (content === null) rmSync(versionFile);
    else writeFileSync(versionFile, content);

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("install.sh: mods/demo/VERSION must hold MAJOR.MINOR.PATCH\n");
  });

  test.each([
    ["nope", "nope is not mods/<name> or layouts/<name>"],
    ["mods/nope", "no mods/nope in this repo"],
    ["mods/../demo", "no mods/../demo in this repo"],
    ["mods/.hidden", "no mods/.hidden in this repo"],
    ["layouts/nope", "no layouts/nope in this repo"],
  ])("rejects %s", (item, message) => {
    const repo = makeRepo();
    mkdirSync(join(repo, "mods", ".hidden"));
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "status", "--app-home", home, item);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`install.sh: ${message}\n`);
  });

  test("accepts a mod folder path with a trailing slash", () => {
    const repo = makeRepo({ demo: {}, other: {} });
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "status", "--app-home", home, "mods/demo/");

    expect(result.stdout).toBe("mods/demo: absent (repo 0.1.0)\n");
  });

  test("rejects an app home that does not exist", () => {
    const repo = makeRepo();
    const home = join(tempDir("herdr-app-home-"), "missing");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`install.sh: no app home at ${home}\n`);
  });
});

describe("layouts", () => {
  test("install puts mods in before layouts and keeps a layout's manifest beside it", () => {
    const repo = makeRepo({ demo: {} }, { jj: {} });
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "install", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: installed 0.1.0\nlayouts/jj: installed 0.1.0\n");
    expect(readFileSync(join(home, "layouts", "jj.json"), "utf8")).toBe(layoutJson("demo"));
    expect(existsSync(join(home, "layouts", "jj.VERSION"))).toBe(false);
    const manifest = readFileSync(join(home, "layouts", ".jj.herdr-mods"), "utf8").split("\n");
    expect(manifest).toContain("layout=jj");
    expect(manifest).toContain("version=0.1.0");
    expect(manifest).toContain(`file=${sha256(layoutJson("demo"))} jj.json`);
  });

  test("status tracks a layout's version and edits, ignoring other layouts", () => {
    const repo = makeRepo({}, { jj: {} });
    const home = tempDir("herdr-app-home-");
    mkdirSync(join(home, "layouts"));
    writeFileSync(join(home, "layouts", "main.json"), layoutJson("tabs"));
    run(repo, "install", "--app-home", home);
    writeFileSync(join(repo, "layouts", "jj.VERSION"), "0.2.0\n");
    writeFileSync(join(home, "layouts", "jj.json"), layoutJson("edited"));

    const result = run(repo, "status", "--app-home", home);

    expect(result.stdout).toBe("layouts/jj: older 0.1.0 (repo 0.2.0), edited\n");
  });

  test("refuses to replace a layout this script did not install", () => {
    const repo = makeRepo({}, { main: {} });
    const home = tempDir("herdr-app-home-");
    mkdirSync(join(home, "layouts"));
    writeFileSync(join(home, "layouts", "main.json"), layoutJson("tabs"));

    const result = run(repo, "install", "--force", "--app-home", home, "layouts/main.json");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("layouts/main: foreign (no .herdr-mods manifest)");
    expect(readFileSync(join(home, "layouts", "main.json"), "utf8")).toBe(layoutJson("tabs"));
  });

  test("uninstall takes layouts out before mods and removes the manifest too", () => {
    const repo = makeRepo({ demo: {} }, { jj: {} });
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);

    const result = run(repo, "uninstall", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("layouts/jj: uninstalled 0.1.0\nmods/demo: uninstalled 0.1.0\n");
    expect(existsSync(join(home, "layouts", "jj.json"))).toBe(false);
    expect(existsSync(join(home, "layouts", ".jj.herdr-mods"))).toBe(false);
  });

  test("rejects a layout without a valid VERSION file", () => {
    const repo = makeRepo({}, { jj: {} });
    rmSync(join(repo, "layouts", "jj.VERSION"));
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("install.sh: layouts/jj.VERSION must hold MAJOR.MINOR.PATCH\n");
  });
});

describe("uninstall", () => {
  test("removes an installed mod and skips one that is not installed", () => {
    const repo = makeRepo({ demo: {}, other: {} });
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home, "mods/demo");

    const result = run(repo, "uninstall", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: uninstalled 0.1.0\nmods/other: not installed\n");
    expect(existsSync(join(home, "mods", "demo"))).toBe(false);
  });

  test("refuses a foreign folder even with --force and removes nothing", () => {
    const repo = makeRepo({ demo: {}, other: {} });
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home, "mods/demo");
    mkdirSync(join(home, "mods", "other"));

    const result = run(repo, "uninstall", "--force", "--app-home", home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mods/other: foreign (no .herdr-mods manifest); not removing it");
    expect(result.stderr).toContain("nothing was uninstalled");
    expect(existsSync(join(home, "mods", "demo", "main.js"))).toBe(true);
    expect(existsSync(join(home, "mods", "other"))).toBe(true);
  });

  test("refuses to remove local edits unless forced", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    writeFileSync(join(home, "mods", "demo", "main.js"), "// local edit\n");

    const refused = run(repo, "uninstall", "--app-home", home);
    const stillThere = existsSync(join(home, "mods", "demo", "main.js"));
    const forced = run(repo, "uninstall", "--force", "--app-home", home);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("mods/demo: installed files were edited; --force removes them");
    expect(stillThere).toBe(true);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toBe("mods/demo: uninstalled 0.1.0, removing local edits\n");
    expect(existsSync(join(home, "mods", "demo"))).toBe(false);
  });
});

describe("status", () => {
  test("reports a mod that is not installed as absent", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: absent (repo 0.1.0)\n");
  });

  test("reports an installed mod at the repo version as same", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: same 0.1.0\n");
  });

  test("compares versions numerically per field to report older and newer", () => {
    const repo = makeRepo({ demo: { version: "0.9.0" }, other: { version: "0.10.0" } });
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    writeFileSync(join(repo, "mods", "demo", "VERSION"), "0.10.0\n");
    writeFileSync(join(repo, "mods", "other", "VERSION"), "0.9.1\n");

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("mods/demo: older 0.9.0 (repo 0.10.0)\nmods/other: newer 0.10.0 (repo 0.9.1)\n");
  });

  test.each([
    ["no manifest", null, "no .herdr-mods manifest"],
    ["another manifest format", ["format=1", "format=2"], "manifest format 2, expected 1"],
    ["another owner", ["owner=herdr-mods", "owner=someone-else"], "owned by someone-else"],
    ["a manifest for another item", ["mod=demo", "mod=demo-copy"], "manifest is for mods/demo-copy"],
    ["a malformed version", ["version=0.1.0", "version=1.0"], "manifest version 1.0 is not MAJOR.MINOR.PATCH"],
  ])("reports a folder with %s as foreign", (_, replacement, reason) => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    const manifest = join(home, "mods", "demo", ".herdr-mods");
    if (replacement) {
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace(...replacement));
    } else {
      rmSync(manifest);
    }

    const result = run(repo, "status", "--app-home", home);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`mods/demo: foreign (${reason})\n`);
  });

  test.each([
    ["a changed file", (dir) => writeFileSync(join(dir, "main.js"), "// changed\n")],
    ["an added file", (dir) => writeFileSync(join(dir, "ui.js"), "export {};\n")],
    ["a removed file", (dir) => rmSync(join(dir, "mod.json"))],
  ])("flags an installed mod with %s as edited", (_, edit) => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    edit(join(home, "mods", "demo"));

    const result = run(repo, "status", "--app-home", home);

    expect(result.stdout).toBe("mods/demo: same 0.1.0, edited\n");
  });

  test("notes repo changes made without a version bump", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    writeFileSync(join(repo, "mods", "demo", "main.js"), demoMain.replace('"demo"', '"demo 2"'));

    const result = run(repo, "status", "--app-home", home);

    expect(result.stdout).toBe("mods/demo: same 0.1.0, repo changed without a version bump\n");
  });

  test("ignores files the app writes and hidden files when looking for edits", () => {
    const repo = makeRepo();
    const home = tempDir("herdr-app-home-");
    run(repo, "install", "--app-home", home);
    const installed = join(home, "mods", "demo");
    writeFileSync(join(installed, "gpui-kit.d.ts"), "// app types\n");
    writeFileSync(join(installed, "jsconfig.json"), "{}\n");
    writeFileSync(join(installed, ".DS_Store"), "");

    const result = run(repo, "status", "--app-home", home);

    expect(result.stdout).toBe("mods/demo: same 0.1.0\n");
  });
});

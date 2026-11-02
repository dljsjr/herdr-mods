// Throwaway jj repos for tests. tests/setup.js points jj at tests/jj-config.toml.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = [];

// Each test file registers this itself with afterEach: a hook registered in
// a shared module only applies to the first file that imports it.
export function removeTempDirs() {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-mods-jj-")));
  scratch.push(dir);
  return dir;
}

export function run(args, cwd, command = "jj") {
  const result = Bun.spawnSync([command, ...args], { cwd, env: process.env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function must(args, cwd, command = "jj") {
  const result = run(args, cwd, command);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

export const exec = async (command, args, cwd) => run(args, cwd, command);
export const readText = async (path) => readFileSync(path, "utf8");

// A repo at <dir>/main with one commit, colocated with Git or not.
export function makeRepo({ colocate = true } = {}) {
  const dir = tempDir();
  must(["git", "init", ...(colocate ? ["--colocate"] : ["--no-colocate"]), "main"], dir);
  const main = join(dir, "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  must(["commit", "-m", "base"], main);
  return { dir, main };
}

export function addWorkspace({ dir, main }, name) {
  const path = join(dir, "ws", name);
  mkdirSync(join(dir, "ws"), { recursive: true });
  must(["workspace", "add", "--name", name, path], main);
  return path;
}

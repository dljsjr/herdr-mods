import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mods = join(import.meta.dir, "..", "mods");

// A mod can't import from outside its folder, so each one that needs it
// keeps a copy of jj-repo.js. Change one, copy it to the others.
test("every copy of jj-repo.js is the same", () => {
  const copies = ["jj-workspaces", "jj-spaces", "jj-menu", "jj-graph", "jj-new-menu"].map((m) => readFileSync(join(mods, m, "jj-repo.js"), "utf8"));

  expect(new Set(copies).size).toBe(1);
});

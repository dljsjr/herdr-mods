import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const layout = JSON.parse(readFileSync(join(root, "layouts", "jj.json"), "utf8"));

function blocks(node) {
  return [node, ...(node.children ?? []).flatMap(blocks)];
}

test("the jj layout is main with jj mods in the changes, spaces and tabs blocks, plus a graph panel", () => {
  const all = blocks(layout);
  const modOf = (id) => all.find((b) => b.id === id).content.mod;

  expect(layout.cloned_from.name).toBe("main");
  expect([modOf("changes"), modOf("spaces"), modOf("tabs")]).toEqual(["jj-changes", "jj-spaces", "jj-tabs"]);
  expect(all.filter((b) => ["changes", "spaces", "tabs"].includes(b.content?.mod))).toEqual([]);
  expect(all.find((b) => b.id === "panel-body").children.map((b) => b.id)).toEqual(["files", "changes", "graph"]);
  expect(modOf("graph")).toBe("jj-graph");
});

test("every jj mod the layout names is in this repo", () => {
  const named = blocks(layout).map((b) => b.content?.mod).filter((m) => m?.startsWith("jj-"));

  expect(named.filter((m) => !existsSync(join(root, "mods", m, "main.js")))).toEqual([]);
});

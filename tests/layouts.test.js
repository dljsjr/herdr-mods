import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const layout = JSON.parse(readFileSync(join(import.meta.dir, "..", "layouts", "jj.json"), "utf8"));

function blocks(node) {
  return [node, ...(node.children ?? []).flatMap(blocks)];
}

test("the jj layout is main with jj-changes in the Changes slot", () => {
  const all = blocks(layout);

  expect(layout.cloned_from.name).toBe("main");
  expect(all.find((b) => b.id === "changes").content).toEqual({ mod: "jj-changes" });
  expect(all.filter((b) => b.content?.mod === "changes")).toEqual([]);
});

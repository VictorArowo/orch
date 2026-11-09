import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTree } from "../src/core/tree.ts";
import { addChild, findStep, moveStep, removeStep, updateStep } from "../src/view/edit.ts";
import { layout, SIZES } from "../src/view/layout.ts";
import { edgesOf, viewOfRun, viewOfSpec } from "../src/view/view.ts";
import { harness, tree } from "./helpers.ts";

const example = () => parseTree(JSON.parse(readFileSync("examples/vector-dbs.tree.json", "utf8")));

describe("canvas view", () => {
  it("shows a fan-out as its template until it has branches", async () => {
    const v = viewOfSpec(example().root);
    const research = v.children.find((c) => c.id === "research")!;
    expect(research.kind).toBe("group");
    expect(research.children.map((c) => [c.id, c.kind, c.ownerId])).toEqual([["research.template", "stack", "research"]]);

    const h = await harness();
    const state = await h.run(tree({ children: [{ id: "pick", output: "list", instructions: "Name three." }, { id: "each", itemsFrom: "pick", template: {} }] }));
    const run = viewOfRun(state);
    expect(run.children[1]!.children.map((c) => c.id)).toEqual(["each.1", "each.2", "each.3"]);
    await h.close();
  });

  it("draws order, reads and items edges without repeating the previous step", () => {
    const edges = edgesOf(viewOfSpec(example().root));
    expect(edges.filter((e) => e.kind === "next").map((e) => `${e.source}>${e.target}`)).toEqual(["pick>research", "research>compare", "compare>recommend"]);
    // compare reads research, which is already the step before it.
    expect(edges.filter((e) => e.kind === "reads").map((e) => `${e.source}>${e.target}`)).toEqual(["research>recommend"]);
    expect(edges.filter((e) => e.kind === "items").map((e) => `${e.source}>${e.target}`)).toEqual(["pick>research"]);
  });

  it("lays out parents before children, and wraps wide parallel steps into rows", () => {
    const t = tree({ id: "fan", items: ["a", "b", "c", "d", "e"], template: {} });
    const view = { ...viewOfSpec(t.root), children: t.root.children.map(viewOfSpec) };
    const { nodes } = layout(view, { maxCols: 3 });
    const ids = nodes.map((n) => n.id);
    expect(ids[0]).toBe("fan");
    const kids = nodes.filter((n) => n.parentId === "fan");
    expect(new Set(kids.slice(0, 3).map((k) => k.y)).size).toBe(1);
    expect(kids[3]!.y).toBeGreaterThan(kids[0]!.y);
    // No two siblings overlap.
    for (const a of kids)
      for (const b of kids) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    // The box is wide enough for its widest row.
    const box = nodes[0]!;
    expect(box.w).toBeGreaterThanOrEqual(3 * SIZES.leafW + 2 * SIZES.parGap);
  });
});

describe("tree edits", () => {
  it("changes a step and keeps the tree well formed", () => {
    const t = updateStep(example(), "compare", { role: "writer", check: "fact-checker", title: "Compare" });
    const s = findStep(t.root, "compare")!.step;
    expect([s.role, s.check, s.title]).toEqual(["writer", "fact-checker", "Compare"]);
    const cleared = updateStep(t, "compare", { check: "" });
    expect(findStep(cleared.root, "compare")!.step.check).toBeUndefined();
  });

  it("edits a fan-out's template, which every branch is made from", () => {
    const t = tree({ id: "fan", items: ["a", "b"], template: { title: "Do {{item}}" } });
    const next = updateStep(t, "fan.template", { title: "Look at {{item}}" });
    expect(next.root.children.map((c) => c.title)).toEqual(["Look at a", "Look at b"]);
    const fromList = updateStep(tree({ children: [{ id: "pick", output: "list" }, { id: "fan", items: ["a"], template: {} }] }), "fan", { itemsFrom: "pick", items: [] });
    expect(findStep(fromList.root, "fan")!.step).toMatchObject({ itemsFrom: "pick" });
    expect(findStep(fromList.root, "fan")!.step.items).toBeUndefined();
  });

  it("adds, moves and removes steps", () => {
    const { tree: added, id } = addChild(example(), "root");
    expect(added.root.children.at(-1)!.id).toBe(id);
    const moved = moveStep(added, id, -1);
    expect(moved.root.children.map((c) => c.id).slice(-2)).toEqual([id, "recommend"]);
    const removed = removeStep(moved, id);
    expect(removed.root.children.map((c) => c.id)).toEqual(["pick", "research", "compare", "recommend"]);
    expect(() => removeStep(tree({ children: [{ id: "only" }] }), "only")).toThrow(/at least one step/);
    expect(() => removeStep(example(), "root")).toThrow(/root/);
  });
});

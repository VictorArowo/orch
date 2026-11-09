import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePanel } from "../src/core/panel.ts";
import { DEFAULT_LIMITS, expandTemplate, parseTree, validateTree } from "../src/core/tree.ts";
import { harness, panel, tree } from "./helpers.ts";

describe("tree format", () => {
  it("parses the example tree and starter panel", () => {
    const t = parseTree(JSON.parse(readFileSync("examples/vector-dbs.tree.json", "utf8")));
    const p = parsePanel(JSON.parse(readFileSync("panels/starter.json", "utf8")));
    const { models } = validateTree(t, p, DEFAULT_LIMITS);
    expect(t.root.children.map((c) => c.id)).toEqual(["pick", "research", "compare", "recommend"]);
    expect(t.root.children[1]!.itemsFrom).toBe("pick");
    expect(models.has("openai/gpt-5.6-luna")).toBe(true);
  });

  it("fills in ids and infers modes", () => {
    const t = tree({ children: [{ title: "A" }, { items: ["x", "y"], template: { title: "Do {{item}}" } }] });
    expect(t.root.id).toBe("root");
    expect(t.root.mode).toBe("sequence");
    const [a, fan] = t.root.children;
    expect(a!.id).toBe("root.1");
    expect(a!.mode).toBe("leaf");
    expect(fan!.mode).toBe("parallel");
    expect(fan!.children.map((c) => [c.id, c.title, c.item])).toEqual([
      ["root.2.1", "Do x", "x"],
      ["root.2.2", "Do y", "y"],
    ]);
  });

  it("expands nested templates with fresh ids", () => {
    const t = tree({ id: "fan", items: ["a"], template: { children: [{ title: "{{item}} one" }, { title: "{{item}} two" }] } });
    const kids = expandTemplate(t.root, ["p", "q"]);
    expect(kids.map((k) => k.children.map((c) => `${c.id}:${c.title}`))).toEqual([
      ["fan.1.1:p one", "fan.1.2:p two"],
      ["fan.2.1:q one", "fan.2.2:q two"],
    ]);
  });

  it.each([
    [{ role: "nobody" }, /isn't in panel/],
    [{ role: "checker" }, /its job is check/],
    [{ children: [{ check: "worker" }] }, /its job is do/],
    [{ children: [{ inputs: ["ghost"] }] }, /doesn't exist/],
    [{ children: [{ id: "a" }, { itemsFrom: "a", template: {} }] }, /must be a leaf with "output": "list"/],
    [{ children: [{ children: [{ children: [{ children: [{}] }] }] }] }, /depth 5/],
    [{ items: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], template: {} }, /fan-out limit is 8/],
  ])("rejects %j", (root, message) => {
    expect(() => validateTree(tree(root), panel, DEFAULT_LIMITS)).toThrow(message);
  });

  it("rejects ids inside templates and leaves with children", () => {
    expect(() => tree({ items: ["a"], template: { id: "fixed" } })).toThrow(/can't set an id/);
    expect(() => tree({ mode: "leaf", children: [{}] })).toThrow(/is a leaf/);
  });

  it("refuses a tree whose steps wait on each other", async () => {
    const h = await harness();
    // The first child reads the second, but the sequence makes the second wait for the first.
    const t = tree({ children: [{ id: "a", inputs: ["b"] }, { id: "b" }] });
    await expect(h.run(t)).rejects.toThrow(/loop/);
    await h.close();
  });
});

describe("panels", () => {
  it("rejects a ladder on a check role and a jury on a do role", () => {
    expect(() => parsePanel({ name: "p", roles: [{ name: "d", job: "do", model: "x" }, { name: "c", job: "check", ladder: ["a", "b"] }] })).toThrow(
      /ladder/,
    );
    expect(() => parsePanel({ name: "p", roles: [{ name: "d", job: "do", jury: ["a", "b"] }] })).toThrow(/jury/);
  });

  it("needs a do role and exactly one model spec per role", () => {
    expect(() => parsePanel({ name: "p", roles: [{ name: "c", job: "check", model: "x" }] })).toThrow(/no do role/);
    expect(() => parsePanel({ name: "p", roles: [{ name: "d", job: "do", model: "x", ladder: ["a", "b"] }] })).toThrow(/exactly one/);
  });
});

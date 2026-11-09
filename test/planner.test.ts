import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTree, treeToJson } from "../src/core/check-tree.js";
import { usdToNanos } from "../src/core/money.js";
import { parsePanel } from "../src/core/panel.js";
import { DEFAULT_LIMITS, parseTree } from "../src/core/tree.js";
import { GatewayError } from "../src/gateway/gateway.js";
import { MockGateway } from "../src/gateway/mock.js";
import { plan, PlanError } from "../src/planner/planner.js";
import { repairPlan } from "../src/planner/repair.js";
import { harness, panel, tree } from "./helpers.js";

const starter = parsePanel(JSON.parse(readFileSync("panels/starter.json", "utf8")));
const goals = JSON.parse(readFileSync("examples/goals.json", "utf8")) as { id: string; goal: string; maxSteps: number }[];
const cap = usdToNanos(1);

describe("planner", () => {
  it.each(goals.map((g) => [g.id, g.goal]))("drafts a valid tree for %s with the mock", async (_id, goal) => {
    const r = await plan({ goal, panel: starter, limits: DEFAULT_LIMITS, gateway: new MockGateway(), capNanos: cap });
    expect(r.tree.goal).toBe(goal);
    expect(r.attempts).toHaveLength(1);
    expect(r.repairs).toEqual([]);
    expect(() => checkTree(r.tree, starter, DEFAULT_LIMITS)).not.toThrow();
  });

  it("answers a simple question with a single step", async () => {
    const r = await plan({ goal: "What is the capital of Australia?", panel: starter, limits: DEFAULT_LIMITS, gateway: new MockGateway(), capNanos: cap });
    expect(r.tree.root.mode).toBe("leaf");
  });

  it("tells the planner the roles, limits and format", async () => {
    let prompt = "";
    const gateway = new MockGateway({
      respond(req) {
        prompt = req.messages[1]!.content;
        return undefined;
      },
    });
    await plan({ goal: "Write a post about caching.", panel: starter, limits: { maxDepth: 3, maxFanOut: 5, maxSteps: 20 }, gateway, capNanos: cap });
    expect(prompt).toContain("Goal: Write a post about caching.");
    expect(prompt).toContain("- researcher (do)");
    expect(prompt).toContain("- editor (check)");
    expect(prompt).not.toContain("- planner (plan)");
    expect(prompt).toContain("at most 3 levels");
    expect(prompt).toContain("at most 5 children");
  });

  it("asks again with the problems when a plan doesn't validate", async () => {
    const requests: { role: string; content: string }[][] = [];
    const tooDeep = { root: { children: [{ children: [{ children: [{ children: [{ title: "deep" }] }] }] }] } };
    const gateway = new MockGateway({
      respond(req) {
        requests.push(req.messages);
        return requests.length === 1 ? `Here you go:\n${JSON.stringify(tooDeep)}` : undefined;
      },
    });
    const r = await plan({ goal: "Write a post about caching.", panel: starter, limits: DEFAULT_LIMITS, gateway, capNanos: cap });
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.problems[0]).toMatch(/depth 5/);
    const retry = requests[1]!;
    expect(retry.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry[2]!.content).toContain("Here you go");
    expect(retry[3]!.content).toMatch(/can't be used:\n- .*depth 5/);
    expect(r.costNanos).toBe(r.attempts[0]!.costNanos + r.attempts[1]!.costNanos);
  });

  it("gives up after the last attempt and reports every problem", async () => {
    const gateway = new MockGateway({ respond: () => "I would rather not." });
    const err = await plan({ goal: "Anything.", panel: starter, limits: DEFAULT_LIMITS, gateway, capNanos: cap, maxAttempts: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).attempts.map((a) => a.problems[0])).toEqual(["no JSON object found", "no JSON object found"]);
  });

  it("stops before a call that could pass the planning cap", async () => {
    const gateway = new MockGateway();
    const err = await plan({ goal: "Anything.", panel: starter, limits: DEFAULT_LIMITS, gateway, capNanos: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect((err as Error).message).toMatch(/planning needs up to/);
    expect(gateway.callCount).toBe(0);
  });

  it("retries a failed call but not one that can't succeed", async () => {
    let n = 0;
    const flaky = new MockGateway({
      respond() {
        if (n++ === 0) throw new GatewayError("rate limited", true);
        return undefined;
      },
    });
    const r = await plan({ goal: "Anything.", panel: starter, limits: DEFAULT_LIMITS, gateway: flaky, capNanos: cap });
    expect(r.attempts.map((a) => a.problems)).toEqual([["call failed: rate limited"], []]);

    const broken = new MockGateway({
      respond() {
        throw new GatewayError("no such model", false);
      },
    });
    await expect(plan({ goal: "Anything.", panel: starter, limits: DEFAULT_LIMITS, gateway: broken, capNanos: cap })).rejects.toThrow(/no such model/);
    expect(broken.callCount).toBe(1);
  });

  it("needs a plan role", async () => {
    const noPlanner = parsePanel({ name: "p", roles: [{ name: "d", job: "do", model: "m" }] });
    await expect(plan({ goal: "x", panel: noPlanner, limits: DEFAULT_LIMITS, gateway: new MockGateway(), capNanos: cap })).rejects.toThrow(/no plan role/);
  });
});

describe("repairs", () => {
  const ctx = { goal: "The goal", panel, limits: { ...DEFAULT_LIMITS, maxFanOut: 5 } };

  it("fixes small slips and records each one", () => {
    const raw = {
      title: "Bare root",
      mode: "Sequential",
      notes: "extra",
      children: [
        { id: "Find Things", role: "WORKER", output: "list", priority: 1 },
        { id: "find-things", role: "checker", check: "critic", critique: "critic" },
        { mode: "fan-out", items: ["a", "b", "c", "d", "e", "f"], template: { id: "x", role: "worker" } },
        { id: "end", inputs: "find-things", role: "writer" },
        { id: "last", inputs: ["ghost", "end"] },
      ],
    };
    const { value, repairs } = repairPlan(raw, ctx);
    const t = parseTree(value);
    expect(() => checkTree(t, panel, ctx.limits)).not.toThrow();
    expect(t.goal).toBe("The goal");
    expect(t.root.mode).toBe("sequence");
    const [a, b, fan, end, last] = t.root.children;
    expect([a!.id, a!.role]).toEqual(["find-things", "worker"]);
    expect(b!.id).toBe("find-things-2");
    expect(b!.role).toBeUndefined();
    expect(b!.check).toBeUndefined();
    expect(b!.critique).toBe("critic");
    expect(fan!.mode).toBe("parallel");
    expect(fan!.items).toEqual(["a", "b", "c", "d", "e"]);
    expect(end!.inputs).toEqual(["find-things"]);
    expect(last!.inputs).toEqual(["end"]);
    expect(repairs.sort()).toEqual(
      [
        "wrapped a bare step as the root",
        'step root: removed unknown field "notes"',
        'step root: mode "Sequential" read as "sequence"',
        'id "Find Things" became "find-things"',
        'step find-things: removed unknown field "priority"',
        'step find-things: "WORKER" read as role "worker"',
        'step find-things: dropped role "checker", which isn\'t a do role in the panel',
        'step find-things: dropped check "critic", which isn\'t a check role in the panel',
        'step root.3: mode "fan-out" read as "parallel"',
        "step root.3: kept the first 5 of 6 items",
        "step root.3 template: removed an id inside a template",
        'renamed duplicate id "find-things" to "find-things-2"',
        "step last: dropped inputs that don't exist (ghost)",
      ].sort(),
    );
  });

  it("leaves real problems for validation", () => {
    const raw = { root: { children: [{ id: "a", inputs: ["b"] }, { id: "b" }] } };
    const { value } = repairPlan(raw, ctx);
    expect(() => checkTree(parseTree(value), panel, ctx.limits)).toThrow(/loop/);
  });
});

describe("tree files", () => {
  it("round-trips the example and drafted trees", async () => {
    const example = parseTree(JSON.parse(readFileSync("examples/vector-dbs.tree.json", "utf8")));
    expect(parseTree(treeToJson(example))).toEqual(example);
    const staticFan = tree({ children: [{ id: "f", items: ["x", "y"], template: { title: "Do {{item}}", role: "worker" } }, { inputs: ["f"] }] });
    expect(parseTree(treeToJson(staticFan))).toEqual(staticFan);
    expect(JSON.stringify(treeToJson(staticFan))).not.toContain('"children":[{"id":"f.1"');
    for (const g of goals) {
      const r = await plan({ goal: g.goal, panel: starter, limits: DEFAULT_LIMITS, gateway: new MockGateway(), capNanos: cap });
      expect(parseTree(treeToJson(r.tree))).toEqual(r.tree);
    }
  });
});

describe("drafting cost in a run", () => {
  it("counts the planner's cost against the run's cap", async () => {
    const h = await harness();
    const drafted = { model: "m/plan", costNanos: 12_345, attempts: 2, repairs: ["x"] };
    const runId = await h.engine.createRun({ tree: tree({ id: "s" }), panel, capNanos: usdToNanos(1), drafted });
    const before = await h.engine.state(runId);
    expect(before.spentNanos).toBe(12_345);
    expect(before.drafted).toEqual(drafted);
    await h.engine.start(runId);
    const after = await h.engine.drive(runId);
    expect(after.spentNanos).toBeGreaterThan(12_345);
    await expect(h.engine.createRun({ tree: tree({ id: "s" }), panel, capNanos: 10_000, drafted })).rejects.toThrow(/more than the cap/);
    await h.close();
  });
});

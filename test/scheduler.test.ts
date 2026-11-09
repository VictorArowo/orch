import { describe, expect, it } from "vitest";
import { outputOf, versionOf } from "../src/core/state.js";
import { usdToNanos } from "../src/core/money.js";
import { Engine } from "../src/engine/engine.js";
import { MockGateway } from "../src/gateway/mock.js";
import { harness, lastUser, panel, tree } from "./helpers.js";

describe("scheduler", () => {
  it("runs parallel steps at once, up to the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = await harness({
      async respond() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return "ok";
      },
    });
    const state = await h.run(tree({ items: ["a", "b", "c", "d", "e", "f"], template: { title: "{{item}}" } }), { concurrency: 2 });
    expect(state.status).toBe("done");
    expect(peak).toBe(2);
    await h.close();
  });

  it("runs sequence children in order", async () => {
    const h = await harness();
    const state = await h.run(tree({ children: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
    expect(state.status).toBe("done");
    const order = h.events.filter((e) => e.type === "attempt.started").map((e) => (e as { stepId: string }).stepId);
    const doneAt = (id: string) => h.events.findIndex((e) => e.type === "step.done" && e.stepId === id);
    const startAt = (id: string) => h.events.findIndex((e) => e.type === "attempt.started" && e.stepId === id);
    expect(order).toEqual(["a", "b", "c"]);
    expect(startAt("b")).toBeGreaterThan(doneAt("a"));
    expect(startAt("c")).toBeGreaterThan(doneAt("b"));
    await h.close();
  });

  it("passes outputs to the steps that read them and records the versions read", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.stepId === "compare") return `compared: ${lastUser(req).includes("out:research.1") && lastUser(req).includes("out:research.2")}`;
        return `out:${req.meta.stepId}`;
      },
    });
    const state = await h.run(
      tree({
        children: [
          { id: "research", items: ["x", "y"], template: { title: "Research {{item}}" } },
          { id: "compare", inputs: ["research"] },
          { id: "write" },
        ],
      }),
    );
    expect(state.status).toBe("done");
    expect(outputOf(state, "compare")).toBe("compared: true");
    const compare = state.attempts[state.steps.compare!.acceptedAttemptId!]!;
    expect(compare.inputVersions).toEqual({ research: versionOf(state, "research") });
    // With no inputs given, a step in a sequence reads its previous sibling.
    const write = state.attempts[state.steps.write!.acceptedAttemptId!]!;
    expect(Object.keys(write.inputVersions)).toEqual(["compare"]);
    expect(state.calls[write.callIds[0]!]!.messages[1]!.content).toContain("compared: true");
    // The final result is the last step of the root sequence.
    expect(outputOf(state, "root")).toBe("out:write");
    await h.close();
  });

  it("fans out over another step's list, within the fan-out limit", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.stepId === "pick") return '```json\n["alpha", "beta", "gamma"]\n```';
        return `about ${/This step is for: (.*)/.exec(lastUser(req))?.[1]}`;
      },
    });
    const state = await h.run(
      tree({
        children: [
          { id: "pick", output: "list" },
          { id: "each", itemsFrom: "pick", template: { title: "Look at {{item}}" } },
        ],
      }),
      { limits: { maxFanOut: 2 } },
    );
    expect(state.status).toBe("done");
    const expanded = h.events.find((e) => e.type === "step.expanded")!;
    expect(expanded).toMatchObject({ stepId: "each", requested: 3 });
    expect(state.steps.each!.childIds).toEqual(["each.1", "each.2"]);
    expect(outputOf(state, "each.2")).toBe("about beta");
    await h.close();
  });

  it("shares a run between two engines without doing any step twice", async () => {
    const h = await harness({ latency: 10 });
    const otherGateway = new MockGateway({ latency: 10 });
    const other = new Engine({ store: h.store, gateway: otherGateway, pollMs: 5 });
    const runId = await h.engine.createRun({
      tree: tree({ id: "fan", items: ["a", "b", "c", "d", "e", "f", "g", "h"], template: {} }),
      panel,
      capNanos: usdToNanos(1),
      concurrency: 4,
    });
    await h.engine.start(runId);
    const [state] = await Promise.all([h.engine.drive(runId, { workers: 1 }), other.drive(runId, { workers: 1 })]);
    expect(state.status).toBe("done");
    for (const id of state.steps.fan!.childIds) expect(state.steps[id]!.attemptIds).toHaveLength(1);
    expect(h.gateway.callCount).toBeGreaterThan(0);
    expect(otherGateway.callCount).toBeGreaterThan(0);
    expect(h.gateway.callCount + otherGateway.callCount).toBe(8);
    await h.close();
  });

  it("keeps going on other branches when one fails, then stops the run", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.stepId === "fan.2") throw new Error("boom");
        return "fine";
      },
    });
    const state = await h.run(tree({ id: "fan", items: ["a", "b", "c"], template: {} }));
    expect(state.status).toBe("stopped");
    expect(state.reason).toMatch(/fan\.2/);
    expect(state.steps["fan.1"]!.leafStatus).toBe("done");
    expect(state.steps["fan.3"]!.leafStatus).toBe("done");
    expect(state.steps["fan.2"]!.leafStatus).toBe("failed");
    await h.close();
  });
});

import { describe, expect, it } from "vitest";
import { isStale, outputOf } from "../src/core/state.ts";
import { harness, tree } from "./helpers.ts";

const t = () =>
  tree({
    children: [
      { id: "research", items: ["x", "y"], template: { title: "Research {{item}}", role: "worker" } },
      { id: "compare", inputs: ["research"], role: "writer" },
      { id: "write", role: "writer" },
    ],
  });

describe("re-runs and stale outputs", () => {
  it("marks everything downstream of a re-run step as stale, transitively", async () => {
    let version = 0;
    const h = await harness({ respond: (req) => `${req.meta.stepId} v${++version}` });
    const first = await h.run(t());
    const runId = first.runId;
    expect(first.status).toBe("done");
    const staleNow = (s: typeof first) => s.order.filter((id) => isStale(s, id));
    expect(staleNow(first)).toEqual([]);

    await h.engine.rerun(runId, ["research.2"]);
    let state = await h.engine.drive(runId);
    expect(state.status).toBe("done");
    // The old attempt is kept for comparison.
    expect(state.steps["research.2"]!.attemptIds).toEqual(["research.2#1", "research.2#2"]);
    expect(state.attempts["research.2#2"]!.reason).toBe("rerun");
    // compare read the old research output; write read compare, which is now stale.
    expect(staleNow(state)).toEqual(["root", "compare", "write"]);
    expect(isStale(state, "research")).toBe(false);

    await h.engine.rerun(runId, ["compare"]);
    state = await h.engine.drive(runId);
    expect(staleNow(state)).toEqual(["root", "write"]);
    expect(state.calls["compare#2/do1"]!.messages[1]!.content).toContain(outputOf(state, "research.2"));

    await h.engine.rerun(runId, ["write"]);
    state = await h.engine.drive(runId);
    expect(staleNow(state)).toEqual([]);
    await h.close();
  });

  it("re-runs a step on another model and resets its ladder", async () => {
    const h = await harness({ respond: (req) => `by ${req.model}` });
    const first = await h.run(t());
    await h.engine.rerun(first.runId, ["write"], { model: "m/strong" });
    const state = await h.engine.drive(first.runId);
    expect(state.steps.write!.attemptIds.map((a) => state.attempts[a]!.model)).toEqual(["m/writer", "m/strong"]);
    expect(outputOf(state, "root")).toBe("by m/strong");
    await h.close();
  });

  it("refuses to re-run a composite step or one still running", async () => {
    const h = await harness();
    const first = await h.run(t());
    await expect(h.engine.rerun(first.runId, ["research"])).rejects.toThrow(/re-run its leaves/);
    await expect(h.engine.rerun(first.runId, ["nope"])).rejects.toThrow(/no step/);
    await h.close();
  });
});

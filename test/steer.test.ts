import { describe, expect, it } from "vitest";
import { usdToNanos } from "../src/core/money.ts";
import { dependentsOf, outputOf, stepStatus } from "../src/core/state.ts";
import { HELD_REASON } from "../src/engine/engine.ts";
import { STOPPED } from "../src/core/step-machine.ts";
import { deferred, harness, lastUser, panel, tree } from "./helpers.ts";

const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
};

describe("steering a run", () => {
  it("pauses one step, stopping its call, while the rest carry on, then resumes it", async () => {
    const stuck = deferred();
    let first = true;
    const h = await harness({
      async respond(req, _i) {
        if (req.meta.stepId === "fan.2" && first) {
          first = false;
          stuck.resolve();
          await new Promise(() => {});
        }
        return `out ${req.meta.stepId}`;
      },
    });
    const runId = await h.engine.createRun({ tree: tree({ id: "fan", items: ["a", "b", "c"], template: {} }), panel, capNanos: usdToNanos(1) });
    await h.engine.start(runId);
    const driving = h.engine.drive(runId);
    await stuck.promise;
    await h.engine.hold(runId, "fan.2");

    // The others finish; the run then waits on the paused step.
    const paused = await driving;
    expect(paused.status).toBe("paused");
    expect(paused.reason).toBe(HELD_REASON);
    expect(stepStatus(paused, "fan.2")).toBe("held");
    expect(paused.steps["fan.1"]!.leafStatus).toBe("done");
    const stopped = paused.calls["fan.2#1/do1"]!;
    expect(stopped).toMatchObject({ status: "failed", error: STOPPED, costKnown: false, costNanos: stopped.reservedNanos });

    await h.engine.release(runId, "fan.2");
    const done = await h.engine.drive(runId);
    expect(done.status).toBe("done");
    expect(outputOf(done, "fan.2")).toBe("out fan.2");
    // The retry is a new call in the same attempt, not a send-back.
    expect(done.steps["fan.2"]!.attemptIds).toEqual(["fan.2#1"]);
    await h.close();
  });

  it("holds a whole branch until it's released", async () => {
    const h = await harness({ latency: 5 });
    const t = tree({ children: [{ id: "a" }, { id: "fan", items: ["x", "y"], template: {} }, { id: "end" }] });
    const runId = await h.engine.createRun({ tree: t, panel, capNanos: usdToNanos(1) });
    await h.engine.hold(runId, "fan");
    await h.engine.start(runId);
    const paused = await h.engine.drive(runId);
    expect(paused.status).toBe("paused");
    expect(paused.steps.a!.leafStatus).toBe("done");
    expect(paused.steps["fan.1"]!.attemptIds).toEqual([]);
    expect(stepStatus(paused, "fan")).toBe("held");
    await h.engine.release(runId, "fan");
    expect((await h.engine.drive(runId)).status).toBe("done");
    await h.close();
  });

  it("applies an edit from the step's next attempt", async () => {
    const prompts: Record<string, string[]> = {};
    const gate = deferred();
    const h = await harness({
      async respond(req) {
        (prompts[req.meta.stepId] ??= []).push(`${req.model}|${lastUser(req)}`);
        if (req.meta.stepId === "a") await gate.promise;
        return "ok";
      },
    });
    const t = tree({ children: [{ id: "a", instructions: "Old instructions for a." }, { id: "b", role: "worker", instructions: "Old instructions for b." }] });
    const runId = await h.engine.createRun({ tree: t, panel, capNanos: usdToNanos(1) });
    await h.engine.start(runId);
    const driving = h.engine.drive(runId);
    await until(async () => (prompts.a?.length ?? 0) > 0);
    // b hasn't started, so the edit applies to its first attempt.
    await h.engine.edit(runId, "b", { instructions: "New instructions for b.", model: "m/strong" });
    gate.resolve();
    const state = await driving;
    expect(prompts.b![0]).toMatch(/^m\/strong\|/);
    expect(prompts.b![0]).toContain("New instructions for b.");
    expect(state.steps.b!.edits).toBe(1);
    await h.close();
  });

  it("checks edits against the panel", async () => {
    const h = await harness();
    const runId = await h.engine.createRun({ tree: tree({ id: "s", items: ["x"], itemsFrom: undefined, template: {} }), panel, capNanos: usdToNanos(1) });
    await expect(h.engine.edit(runId, "s.1", { role: "checker" })).rejects.toThrow(/check role, not a do role/);
    await expect(h.engine.edit(runId, "s.1", { check: "nobody" })).rejects.toThrow(/no role "nobody"/);
    await expect(h.engine.edit(runId, "s", { instructions: "x" })).rejects.toThrow(/on a box/);
    await expect(h.engine.edit(runId, "s.1", { inputs: ["x"] } as never)).rejects.toThrow(/can't be changed/);
    await h.close();
  });

  it("edits a fan-out's template before it makes its branches", async () => {
    const h = await harness({ respond: (req) => (req.meta.stepId === "pick" ? '["p", "q"]' : lastUser(req).includes("Look closely at") ? "edited" : "original") });
    const t = tree({ children: [{ id: "pick", output: "list" }, { id: "each", itemsFrom: "pick", template: { title: "Look at {{item}}" } }] });
    const runId = await h.engine.createRun({ tree: t, panel, capNanos: usdToNanos(1) });
    await h.engine.edit(runId, "each.template", { instructions: "Look closely at {{item}}." });
    await h.engine.start(runId);
    const state = await h.engine.drive(runId);
    expect([outputOf(state, "each.1"), outputOf(state, "each.2")]).toEqual(["edited", "edited"]);
    expect(state.steps["each.1"]!.spec.instructions).toBe("Look closely at p.");
    await expect(h.engine.edit(runId, "each.template", { instructions: "too late" })).rejects.toThrow(/already made its branches/);
    await h.close();
  });

  it("skips a failed step so a stopped run can finish", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.stepId === "flaky") throw new Error("upstream broke");
        return `out ${req.meta.stepId}`;
      },
    });
    const t = tree({ children: [{ id: "flaky" }, { id: "after" }] });
    const stopped = await h.run(t);
    expect(stopped.status).toBe("stopped");
    await h.engine.skip(stopped.runId, "flaky");
    const done = await h.engine.drive(stopped.runId);
    expect(done.status).toBe("done");
    expect(done.steps.flaky!.skipped).toBe(true);
    expect(outputOf(done, "after")).toBe("out after");
    // The step after read nothing from the skipped one.
    expect(done.calls["after#1/do1"]!.messages[1]!.content).not.toContain("<input");
    await h.close();
  });

  it("finds every step downstream of a change", async () => {
    const h = await harness();
    const state = await h.run(
      tree({
        children: [
          { id: "pick", output: "list" },
          { id: "fan", items: ["x", "y"], template: {} },
          { id: "compare", inputs: ["fan"] },
          { id: "write", inputs: ["compare", "pick"] },
          { id: "unrelated", inputs: ["pick"] },
        ],
      }),
    );
    expect(dependentsOf(state, ["fan.1"])).toEqual(["compare", "write"]);
    expect(dependentsOf(state, ["pick"]).sort()).toEqual(["fan.1", "fan.2", "compare", "write", "unrelated"].sort());
    await h.close();
  });
});

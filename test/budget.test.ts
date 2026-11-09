import { describe, expect, it } from "vitest";
import { decide, promptTokensUpperBound, worstCase } from "../src/core/budget.js";
import { costOf, formatUsd, type Price } from "../src/core/money.js";
import { apply, emptyState } from "../src/core/state.js";
import { harness, tree } from "./helpers.js";

// Simple prices in nanodollars per token: prompts are free and each
// completion token costs 1000, so a 100-token call reserves exactly 100,000.
const flat: Price = { prompt: 0, completion: 1000, request: 0 };

describe("budget arithmetic", () => {
  it("bounds prompt tokens by UTF-8 bytes", () => {
    const messages = [{ role: "user" as const, content: "héllo 👋" }];
    // 11 bytes of text (é is 2, the emoji is 4), plus framing.
    expect(promptTokensUpperBound(messages)).toBe(11 + 8 + 16);
  });

  it("reserves prompt bound, full completion limit and the request fee", () => {
    const price: Price = { prompt: 2, completion: 10, request: 5 };
    const messages = [{ role: "user" as const, content: "abcd" }];
    expect(worstCase(price, messages, 100)).toBe(5 + 2 * (4 + 8 + 16) + 10 * 100);
    expect(costOf(price, 3, 7)).toBe(5 + 6 + 70);
  });

  it("decides ok, wait or blocked", () => {
    expect(decide({ cap: 100, spentNanos: 10, reservedNanos: 20 }, 70)).toEqual({ kind: "ok" });
    expect(decide({ cap: 100, spentNanos: 10, reservedNanos: 20 }, 80)).toEqual({ kind: "wait" });
    expect(decide({ cap: 100, spentNanos: 30, reservedNanos: 0 }, 80)).toEqual({ kind: "blocked", availableNanos: 70 });
  });

  it("formats small amounts with two significant digits", () => {
    expect(formatUsd(4_300_000)).toBe("$0.0043");
    expect(formatUsd(52_000)).toBe("$0.000052");
    expect(formatUsd(500_000_000)).toBe("$0.50");
  });
});

describe("reservations in a run", () => {
  it("reconciles each reservation to the reported cost", async () => {
    const h = await harness({ defaultPrice: flat, respond: () => ({ text: "ok", costNanos: 40_000 }) });
    const state = await h.run(tree({ id: "s", role: "worker" }), { capUsd: 1 });
    const call = state.calls["s#1/do1"]!;
    expect(call.reservedNanos).toBe(100_000);
    expect(call.costNanos).toBe(40_000);
    expect(state.reservedNanos).toBe(0);
    expect(state.spentNanos).toBe(40_000);
    await h.close();
  });

  it("computes the cost from usage when the gateway doesn't report it", async () => {
    const h = await harness({ defaultPrice: flat, reportCost: false, respond: () => ({ text: "ok", completionTokens: 7 }) });
    const state = await h.run(tree({ id: "s", role: "worker" }));
    expect(h.events.find((e) => e.type === "call.finished")).toMatchObject({ costNanos: 7000, costSource: "computed" });
    expect(state.spentNanos).toBe(7000);
    await h.close();
  });

  it("pauses when the next call can't fit, and resumes under a higher cap", async () => {
    const h = await harness({ defaultPrice: flat, respond: () => ({ text: "ok", costNanos: 40_000 }) });
    const t = tree({ children: [{ id: "a", role: "worker" }, { id: "b", role: "worker" }, { id: "c", role: "worker" }] });
    // a and b reserve 100k each and spend 40k each; c needs 100k with 70k left.
    const paused = await h.run(t, { capUsd: 0.00015 });
    expect(paused.status).toBe("paused");
    expect(paused.reason).toMatch(/budget/);
    expect(paused.neededNanos).toBe(100_000);
    expect(paused.spentNanos).toBe(80_000);
    expect(paused.reservedNanos).toBe(0);
    expect(paused.steps.c!.blocked).toEqual({ neededNanos: 100_000, availableNanos: 70_000 });

    await h.engine.resume(paused.runId, { capNanos: 300_000 });
    const done = await h.engine.drive(paused.runId);
    expect(done.status).toBe("done");
    expect(done.spentNanos).toBe(120_000);
    await h.close();
  });

  it("waits for calls in flight to settle instead of pausing", async () => {
    const h = await harness({
      defaultPrice: flat,
      latency: 20,
      respond: () => ({ text: "ok", costNanos: 40_000 }),
    });
    let peakReserved = 0;
    let over = 0;
    const shadow = emptyState("");
    h.engine.on("event", (e) => {
      apply(shadow, e);
      peakReserved = Math.max(peakReserved, shadow.reservedNanos);
      over = Math.max(over, shadow.spentNanos + shadow.reservedNanos - shadow.cap);
    });
    // Room for two worst cases at once, and for all three once costs are known.
    const state = await h.run(tree({ items: ["x", "y", "z"], template: { role: "worker" } }), { capUsd: 0.00025, concurrency: 3 });
    expect(state.status).toBe("done");
    expect(over).toBeLessThanOrEqual(0);
    expect(peakReserved).toBe(200_000);
    expect(state.spentNanos).toBe(120_000);
    await h.close();
  });

  it("never lets spend plus reservations pass the cap", async () => {
    const h = await harness({ checkReviseRate: 0.5, critiqueObjects: true, latency: 2 });
    const shadow = emptyState("");
    let worst = 0;
    h.engine.on("event", (e) => {
      apply(shadow, e);
      worst = Math.max(worst, shadow.spentNanos + shadow.reservedNanos - shadow.cap);
    });
    const t = tree({
      children: [
        { id: "fan", items: ["a", "b", "c", "d", "e", "f"], template: { role: "worker", check: "checker" } },
        { id: "write", role: "writer", check: "jury", critique: "critic" },
      ],
    });
    const state = await h.run(t, { capUsd: 0.004, concurrency: 4 });
    expect(worst).toBeLessThanOrEqual(0);
    expect(["done", "paused"]).toContain(state.status);
    await h.close();
  });
});

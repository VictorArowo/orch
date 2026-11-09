import { describe, expect, it } from "vitest";
import { estimateTree, guessCount } from "../src/core/estimate.ts";
import { usdToNanos, type Price } from "../src/core/money.ts";
import { DEFAULT_LIMITS } from "../src/core/tree.ts";
import { harness, panel, tree } from "./helpers.ts";

// Only completion tokens cost anything here, 1000 nanodollars each, so the
// estimates are easy to read off.
const flat: Price = { prompt: 0, completion: 1000, request: 0 };
const priceOf = async () => flat;

describe("estimates", () => {
  it("prices a lone leaf from typical and maximum reply sizes", async () => {
    // worker: maxTokens 100, so a typical 300-token reply is capped at 100.
    const est = await estimateTree(tree({ id: "s", role: "worker" }), panel, DEFAULT_LIMITS, priceOf);
    expect(est.total).toMatchObject({ low: 100_000, high: 100_000, calls: { low: 1, high: 1 } });
    // writer: maxTokens 200, list output typically 40 tokens.
    const list = await estimateTree(tree({ id: "s", role: "writer", output: "list" }), panel, DEFAULT_LIMITS, priceOf);
    expect(list.total).toMatchObject({ low: 40_000, high: 200_000 });
  });

  it("assumes reviews pass at the low end and use every retry at the high end", async () => {
    const t = tree({ id: "s", role: "worker", check: "jury", critique: "critic", maxRetries: 2 });
    const est = await estimateTree(t, panel, DEFAULT_LIMITS, priceOf);
    // Low: one draft (100) + three jurors (40 each) + one critique (80).
    expect(est.total.low).toBe(1000 * (100 + 3 * 40 + 80));
    expect(est.total.calls.low).toBe(5);
    // High: 2 send-backs + 1 critique revision = 4 drafts, each checked by the
    // jury at its 50-token limit, plus one critique at 50.
    expect(est.total.calls.high).toBe(4 * (1 + 3) + 1);
    expect(est.total.high).toBe(1000 * (4 * 100 + 4 * 3 * 50 + 50));
  });

  it("uses each ladder rung's price at the high end", async () => {
    const prices: Record<string, Price> = {
      "m/cheap": { prompt: 0, completion: 1, request: 0 },
      "m/mid": { prompt: 0, completion: 10, request: 0 },
      "m/strong": { prompt: 0, completion: 100, request: 0 },
      "m/check": { prompt: 0, completion: 0, request: 0 },
    };
    const est = await estimateTree(tree({ id: "s", role: "worker", check: "checker" }), panel, DEFAULT_LIMITS, async (m) => prices[m]!);
    expect(est.total.low).toBe(100);
    expect(est.total.high).toBe(100 * (1 + 10 + 100));
  });

  it("multiplies a fan-out by the number of items its source asks for", async () => {
    const t = tree({
      children: [
        { id: "pick", output: "list", role: "worker", instructions: "Name the five best options." },
        { id: "each", itemsFrom: "pick", template: { role: "worker" } },
      ],
    });
    const est = await estimateTree(t, panel, DEFAULT_LIMITS, priceOf);
    expect(est.steps.each!.branches).toEqual({ low: 5, high: 5 });
    expect(est.steps.each!.low).toBe(5 * 100_000);

    const vague = tree({
      children: [
        { id: "pick", output: "list", role: "worker", instructions: "Name some options." },
        { id: "each", itemsFrom: "pick", template: { role: "worker" } },
      ],
    });
    const v = await estimateTree(vague, panel, { ...DEFAULT_LIMITS, maxFanOut: 6 }, priceOf);
    expect(v.steps.each!.branches).toEqual({ low: 3, high: 6 });
  });

  it("guesses list lengths from the step's wording", () => {
    const spec = (instructions: string) => tree({ id: "s", instructions }).root;
    expect(guessCount(spec("Pick the top 3"))).toBe(3);
    expect(guessCount(spec("Name the five most popular"))).toBe(5);
    expect(guessCount(spec("Name a few"))).toBeUndefined();
  });

  it("puts a real run's spend under the high estimate", async () => {
    const h = await harness({ checkReviseRate: 1, critiqueObjects: true });
    const t = tree({
      children: [
        { id: "pick", output: "list", role: "worker", instructions: "Name the five best options." },
        { id: "each", itemsFrom: "pick", template: { role: "worker", check: "checker" } },
        { id: "write", role: "writer", check: "jury", critique: "critic" },
      ],
    });
    const est = await estimateTree(t, panel, DEFAULT_LIMITS, (m) => h.gateway.price(m));
    const state = await h.run(t, { capUsd: 1 });
    expect(state.status).toBe("done");
    expect(state.spentNanos).toBeLessThanOrEqual(est.total.high);
    expect(est.total.low).toBeLessThan(est.total.high);
    expect(est.total.high).toBeLessThan(usdToNanos(1));
    await h.close();
  });
});

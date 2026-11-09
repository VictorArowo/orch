import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/gateway/gateway.ts";
import { harness, lastUser, tree } from "./helpers.ts";

const verdict = (v: "pass" | "revise", notes: string[] = []) => JSON.stringify({ verdict: v, notes });

describe("check, critique and ladders", () => {
  it("sends work back with notes and moves the ladder up a rung", async () => {
    let checks = 0;
    const h = await harness({
      respond(req) {
        if (req.meta.purpose === "check") return checks++ === 0 ? verdict("revise", ["cite a source"]) : verdict("pass");
        return `draft by ${req.model}`;
      },
    });
    const state = await h.run(tree({ id: "s", role: "worker", check: "checker" }));
    const step = state.steps.s!;
    const attempts = step.attemptIds.map((a) => state.attempts[a]!);
    expect(attempts.map((a) => [a.model, a.reason, a.status])).toEqual([
      ["m/cheap", "initial", "rejected"],
      ["m/mid", "check", "accepted"],
    ]);
    const retryPrompt = state.calls[attempts[1]!.callIds[0]!]!.messages[1]!.content;
    expect(retryPrompt).toContain("- cite a source");
    expect(retryPrompt).toContain("draft by m/cheap");
    expect(step.warning).toBeUndefined();
    await h.close();
  });

  it("stops sending back after the retry limit and accepts with a warning", async () => {
    const h = await harness({ respond: (req) => (req.meta.purpose === "check" ? verdict("revise", ["no"]) : "draft") });
    const state = await h.run(tree({ id: "s", role: "worker", check: "checker", maxRetries: 2 }));
    const step = state.steps.s!;
    expect(step.attemptIds.map((a) => state.attempts[a]!.model)).toEqual(["m/cheap", "m/mid", "m/strong"]);
    expect(step.leafStatus).toBe("done");
    expect(step.warning).toMatch(/send-backs/);
    await h.close();
  });

  it("decides a jury by majority and keeps every vote", async () => {
    const votes: Record<string, "pass" | "revise"> = { "m/j1": "pass", "m/j2": "revise", "m/j3": "pass" };
    const h = await harness({ respond: (req) => (req.meta.purpose === "check" ? verdict(votes[req.model]!, ["n"]) : "draft") });
    const state = await h.run(tree({ id: "s", role: "worker", check: "jury" }));
    const review = state.attempts["s#1"]!.reviews[0]!;
    expect(review.verdict).toBe("pass");
    expect(review.votes.map((v) => v.verdict)).toEqual(["pass", "revise", "pass"]);
    expect(state.steps.s!.attemptIds).toHaveLength(1);
    await h.close();
  });

  it("a split jury that leans revise sends the work back", async () => {
    let round = 0;
    const h = await harness({
      respond(req) {
        if (req.meta.purpose === "do") return `draft ${++round}`;
        if (lastUser(req).includes("draft 2")) return verdict("pass");
        return verdict(req.model === "m/j1" ? "pass" : "revise", [`from ${req.model}`]);
      },
    });
    const state = await h.run(tree({ id: "s", role: "worker", check: "jury" }));
    const first = state.attempts["s#1"]!;
    expect(first.reviews[0]!.verdict).toBe("revise");
    expect(first.rejected!.notes).toEqual(["from m/j2", "from m/j3"]);
    expect(state.steps.s!.acceptedAttemptId).toBe("s#2");
    await h.close();
  });

  it("revises after a critique on the same model, once", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.purpose === "critique") return JSON.stringify({ objections: ["the cost claim is unsupported"] });
        return "draft";
      },
    });
    const state = await h.run(tree({ id: "s", role: "worker", critique: "critic" }));
    const attempts = state.steps.s!.attemptIds.map((a) => state.attempts[a]!);
    expect(attempts.map((a) => [a.model, a.reason])).toEqual([
      ["m/cheap", "initial"],
      ["m/cheap", "critique"],
    ]);
    expect(attempts[1]!.notes).toEqual(["the cost claim is unsupported"]);
    // One critique round by default: the revision is accepted without another critique.
    expect(attempts[1]!.reviews).toHaveLength(0);
    await h.close();
  });

  it("checks the revision that follows a critique", async () => {
    const h = await harness({
      respond(req) {
        if (req.meta.purpose === "critique") return JSON.stringify({ objections: ["weak"] });
        if (req.meta.purpose === "check") return verdict("pass");
        return "draft";
      },
    });
    const state = await h.run(tree({ id: "s", role: "writer", check: "checker", critique: "critic" }));
    const attempts = state.steps.s!.attemptIds.map((a) => state.attempts[a]!);
    expect(attempts.map((a) => a.reviews.map((r) => r.purpose))).toEqual([["check", "critique"], ["check"]]);
    await h.close();
  });

  it("retries a malformed list, then fails after the limit", async () => {
    let n = 0;
    const h = await harness({ respond: (req) => (req.meta.stepId === "a" ? (n++ === 0 ? "not json" : '["x"]') : "ok") });
    const state = await h.run(tree({ children: [{ id: "a", output: "list", role: "worker" }] }));
    expect(state.status).toBe("done");
    expect(state.attempts["a#1"]!.rejected?.reason).toBe("format");
    expect(state.attempts["a#2"]!.model).toBe("m/mid");
    expect(state.attempts["a#2"]!.items).toEqual(["x"]);
    await h.close();

    const h2 = await harness({ respond: () => "never a list" });
    const s2 = await h2.run(tree({ id: "a", output: "list", maxRetries: 1 }));
    expect(s2.status).toBe("stopped");
    expect(s2.steps.a!.error).toMatch(/malformed after 2 tries/);
    await h2.close();
  });

  it("retries a failed call, but fails at once on an error that won't go away", async () => {
    let calls = 0;
    const h = await harness({
      respond() {
        if (calls++ < 2) throw new GatewayError("upstream 503", true);
        return "ok";
      },
    });
    const state = await h.run(tree({ id: "s" }));
    expect(state.status).toBe("done");
    expect(state.attempts["s#1"]!.callIds.map((c) => state.calls[c]!.status)).toEqual(["failed", "failed", "finished"]);
    await h.close();

    const h2 = await harness({
      respond() {
        throw new GatewayError("bad model id", false);
      },
    });
    const s2 = await h2.run(tree({ id: "s" }));
    expect(s2.status).toBe("stopped");
    expect(s2.attempts["s#1"]!.callIds).toHaveLength(1);
    await h2.close();
  });
});

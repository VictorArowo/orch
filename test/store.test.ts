import { describe, expect, it } from "vitest";
import { usdToNanos } from "../src/core/money.js";
import { redact } from "../src/gateway/redact.js";
import { openStore } from "../src/store/open.js";
import { LostLeaseError } from "../src/store/store.js";
import { panel, tree } from "./helpers.js";

// Runs against the embedded database, and against a real Postgres too when
// ORCH_TEST_DATABASE_URL is set (for example after `pnpm db:up`).
const targets = ["memory:", ...(process.env.ORCH_TEST_DATABASE_URL ? [process.env.ORCH_TEST_DATABASE_URL] : [])];

describe.each(targets)("store on %s", (target) => {
  const newRun = async () => {
    const store = await openStore(target);
    const runId = `test_${Math.random().toString(36).slice(2)}`;
    const t = tree({ id: "s" });
    await store.createRun(runId, {
      type: "run.created",
      goal: t.goal,
      root: t.root,
      panel,
      cap: usdToNanos(1),
      limits: { maxDepth: 4, maxFanOut: 8, maxSteps: 60 },
      concurrency: 2,
      gateway: "mock",
    });
    return { store, runId };
  };

  it("appends events in order under the run lock", async () => {
    const { store, runId } = await newRun();
    const { appended } = await store.withRunLock(runId, 1, () => ({ write: { events: [{ type: "run.started" }, { type: "run.done" }] }, result: null }));
    expect(appended.map((e) => [e.seq, e.type])).toEqual([
      [2, "run.started"],
      [3, "run.done"],
    ]);
    const all = await store.readEvents(runId);
    expect(all.map((e) => e.type)).toEqual(["run.created", "run.started", "run.done"]);
    expect((await store.readEvents(runId, 2)).map((e) => e.seq)).toEqual([3]);
    await store.close();
  });

  it("hands each job to one worker and keeps one active job per step", async () => {
    const { store, runId } = await newRun();
    await store.withRunLock(runId, 1, () => ({ write: { events: [], enqueue: ["a", "b", "a"] }, result: null }));
    const j1 = await store.claimJob(runId, "w1", 10_000);
    const j2 = await store.claimJob(runId, "w2", 10_000);
    expect([j1?.stepId, j2?.stepId]).toEqual(["a", "b"]);
    expect(await store.claimJob(runId, "w3", 10_000)).toBeNull();

    // Queuing a step that already has an active job does nothing.
    const { result } = await store.withRunLock(runId, 1, (ctx) => ({ write: { events: [], enqueue: ["a"] }, result: ctx.activeJobs }));
    expect(result).toBe(2);
    expect(await store.claimJob(runId, "w3", 10_000)).toBeNull();
    await store.close();
  });

  it("reclaims expired leases and fences writes from a worker that lost its job", async () => {
    const { store, runId } = await newRun();
    await store.withRunLock(runId, 1, () => ({ write: { events: [], enqueue: ["a"] }, result: null }));
    const job = (await store.claimJob(runId, "old", 1))!;
    await new Promise((r) => setTimeout(r, 20));
    const again = (await store.claimJob(runId, "new", 10_000))!;
    expect(again.id).toBe(job.id);
    expect(again.tries).toBe(2);
    expect(await store.heartbeat(job.id, "old", 10_000)).toBe(false);
    await expect(
      store.withRunLock(runId, 1, () => ({ write: { events: [{ type: "run.started" }] }, result: null }), { jobId: job.id, workerId: "old" }),
    ).rejects.toBeInstanceOf(LostLeaseError);
    expect(await store.readEvents(runId, 1)).toEqual([]);
    await store.close();
  });

  it("hands back jobs from dead workers on request", async () => {
    const { store, runId } = await newRun();
    await store.withRunLock(runId, 1, () => ({ write: { events: [], enqueue: ["a"] }, result: null }));
    await store.claimJob(runId, "ghost", 60_000);
    expect(await store.claimJob(runId, "me", 60_000)).toBeNull();
    expect(await store.reclaimJobs(runId, (id) => id === "ghost")).toBe(1);
    expect((await store.claimJob(runId, "me", 60_000))?.stepId).toBe("a");
    await store.close();
  });
});

describe("redaction", () => {
  it("masks keys in text", () => {
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    expect(redact(`failed with ${key}`)).toBe("failed with [redacted]");
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [redacted]");
    expect(redact("my secret is hunter2hunter2", ["hunter2hunter2"])).toBe("my secret is [redacted]");
  });
});

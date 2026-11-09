import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usdToNanos } from "../src/core/money.ts";
import { Engine } from "../src/engine/engine.ts";
import { MockGateway } from "../src/gateway/mock.ts";
import { openStore } from "../src/store/open.ts";
import { deferred, panel, tree } from "./helpers.ts";

const t = () =>
  tree({
    children: [
      { id: "a", role: "worker" },
      { id: "fan", items: ["x", "y", "z"], template: { role: "worker" } },
      { id: "c", role: "writer" },
    ],
  });

describe("surviving a restart", () => {
  it("resumes a crashed run from its event log and job queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-resume-"));

    // First process: fan.2's call hangs, and the process dies while it does.
    const store1 = await openStore(dir);
    const hung = deferred();
    const gw1 = new MockGateway({
      async respond(req) {
        if (req.meta.stepId === "fan.2") {
          hung.resolve();
          await new Promise(() => {});
        }
        return `out ${req.meta.stepId}`;
      },
    });
    const engine1 = new Engine({ store: store1, gateway: gw1, pollMs: 5, leaseMs: 60_000 });
    const runId = await engine1.createRun({ tree: t(), panel, capNanos: usdToNanos(1), concurrency: 3 });
    await engine1.start(runId);
    void engine1.drive(runId).catch(() => {});
    await hung.promise;
    // Let the other branches finish before the crash.
    for (let i = 0; i < 100; i++) {
      const s = await engine1.state(runId);
      if (s.steps["fan.1"]!.leafStatus === "done" && s.steps["fan.3"]!.leafStatus === "done") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = await engine1.state(runId);
    expect(before.calls["fan.2#1/do1"]!.status).toBe("open");
    const reserved = before.calls["fan.2#1/do1"]!.reservedNanos;
    engine1.kill();
    await new Promise((r) => setTimeout(r, 30));
    await store1.close();

    // Second process: same database, a new worker. The dead worker's job is
    // handed back without waiting out its 60s lease.
    const store2 = await openStore(dir);
    const gw2 = new MockGateway({ respond: (req) => `out ${req.meta.stepId}` });
    const engine2 = new Engine({
      store: store2,
      gateway: gw2,
      pollMs: 5,
      isWorkerDead: (id) => id === engine1.workerId,
    });
    await engine2.resume(runId);
    const state = await engine2.drive(runId);

    expect(state.status).toBe("done");
    // Finished work isn't redone: only fan.2 and c needed calls after the restart.
    expect(gw2.callCount).toBe(2);
    expect(state.steps.a!.attemptIds).toEqual(["a#1"]);
    // The interrupted call might have been billed, so it counts at its worst case.
    const interrupted = state.calls["fan.2#1/do1"]!;
    expect(interrupted).toMatchObject({ status: "failed", error: "interrupted", costKnown: false, costNanos: reserved });
    expect(state.attempts["fan.2#1"]!.callIds).toEqual(["fan.2#1/do1", "fan.2#1/do2"]);
    expect(state.reservedNanos).toBe(0);
    await store2.close();
  });

  it("picks up a dead worker's job once its lease runs out", async () => {
    const store = await openStore("memory:");
    const gw1 = new MockGateway({
      async respond() {
        await new Promise(() => {});
        return "never";
      },
    });
    const engine1 = new Engine({ store, gateway: gw1, pollMs: 5, leaseMs: 150 });
    const runId = await engine1.createRun({ tree: tree({ id: "s" }), panel, capNanos: usdToNanos(1) });
    await engine1.start(runId);
    void engine1.drive(runId).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    engine1.kill();

    // No liveness information: the new worker has to wait for the lease.
    const engine2 = new Engine({ store, gateway: new MockGateway(), pollMs: 5, isWorkerDead: () => false });
    const started = Date.now();
    const state = await engine2.drive(runId);
    expect(state.status).toBe("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(state.calls["s#1/do1"]!.error).toBe("interrupted");
    await store.close();
  });
});

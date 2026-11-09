import type { RunEvent } from "../src/core/events.js";
import { usdToNanos } from "../src/core/money.js";
import { parsePanel, type Panel } from "../src/core/panel.js";
import type { RunState } from "../src/core/state.js";
import { parseTree, type Limits, type Tree } from "../src/core/tree.js";
import { Engine, type EngineOptions } from "../src/engine/engine.js";
import { MockGateway, type MockOptions } from "../src/gateway/mock.js";
import { openStore } from "../src/store/open.js";
import type { Store } from "../src/store/store.js";

export const panel: Panel = parsePanel({
  name: "test",
  roles: [
    { name: "planner", job: "plan", model: "m/plan" },
    { name: "worker", job: "do", ladder: ["m/cheap", "m/mid", "m/strong"], settings: { maxTokens: 100 } },
    { name: "writer", job: "do", model: "m/writer", settings: { maxTokens: 200 } },
    { name: "checker", job: "check", model: "m/check", settings: { maxTokens: 50 } },
    { name: "jury", job: "check", jury: ["m/j1", "m/j2", "m/j3"], settings: { maxTokens: 50 } },
    { name: "critic", job: "critique", model: "m/critic", settings: { maxTokens: 50 } },
  ],
});

export function tree(root: unknown, goal = "Test goal"): Tree {
  return parseTree({ goal, root });
}

export interface Harness {
  store: Store;
  gateway: MockGateway;
  engine: Engine;
  events: RunEvent[];
  run(t: Tree, opts?: { capUsd?: number; concurrency?: number; limits?: Partial<Limits> }): Promise<RunState>;
  close(): Promise<void>;
}

export async function harness(
  mock: MockOptions = {},
  opts: { store?: Store; engine?: Partial<EngineOptions> } = {},
): Promise<Harness> {
  const store = opts.store ?? (await openStore("memory:"));
  const gateway = new MockGateway({ checkReviseRate: 0, critiqueObjects: false, ...mock });
  const engine = new Engine({ store, gateway, pollMs: 5, leaseMs: 2_000, retryBackoffMs: 0, ...opts.engine });
  const events: RunEvent[] = [];
  engine.on("event", (e) => events.push(e));
  return {
    store,
    gateway,
    engine,
    events,
    async run(t, o = {}) {
      const createOpts: Parameters<Engine["createRun"]>[0] = {
        tree: t,
        panel,
        capNanos: usdToNanos(o.capUsd ?? 10),
        concurrency: o.concurrency ?? 4,
      };
      if (o.limits) createOpts.limits = o.limits;
      const runId = await engine.createRun(createOpts);
      await engine.start(runId);
      return engine.drive(runId);
    },
    close: () => store.close(),
  };
}

export function lastUser(req: { messages: { content: string }[] }): string {
  return req.messages[req.messages.length - 1]!.content;
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

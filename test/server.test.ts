import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/core/events.ts";
import { apply, emptyState } from "../src/core/state.ts";
import { MockGateway } from "../src/gateway/mock.ts";
import { serve } from "../src/server/server.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

let root: string;
let store: Store;
let server: Awaited<ReturnType<typeof serve>>;

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${server.url}${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}

// Read a run's event stream until `until` says stop.
async function stream(runId: string, until: (e: RunEvent) => boolean, after = 0): Promise<RunEvent[]> {
  const ctrl = new AbortController();
  const res = await fetch(`${server.url}/api/runs/${runId}/events?after=${after}`, { signal: ctrl.signal });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6)) as RunEvent;
      events.push(e);
      if (until(e)) {
        ctrl.abort();
        return events;
      }
    }
  }
  return events;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orch-serve-"));
  cpSync("panels", join(root, "panels"), { recursive: true });
  cpSync("examples", join(root, "examples"), { recursive: true });
  store = await openStore("memory:");
  server = await serve({ store, gateway: new MockGateway({ latency: 5, checkReviseRate: 0, critiqueObjects: false }), root, port: 0 });
});

afterEach(async () => {
  await server.close();
  await store.close();
});

describe("engine service", () => {
  it("lists panels, example goals and tree files", async () => {
    const panels = await api<{ name: string }[]>("/api/panels");
    expect(panels.json.map((p) => p.name)).toContain("starter");
    const ex = await api<{ goals: unknown[]; trees: { path: string }[] }>("/api/examples");
    expect(ex.json.goals.length).toBeGreaterThanOrEqual(10);
    expect(ex.json.trees.map((t) => t.path)).toContain("examples/vector-dbs.tree.json");
    expect(ex.json.trees.map((t) => t.path)).toContain("examples/planned/capital.tree.json");
    const tree = await api<{ tree: { goal: string } }>("/api/tree?path=examples/vector-dbs.tree.json");
    expect(tree.json.tree.goal).toMatch(/vector databases/);
  });

  it("refuses to read files outside the tree folders", async () => {
    expect((await api("/api/tree?path=../package.json")).status).toBe(400);
    expect((await api("/api/tree?path=panels/starter.json")).status).toBe(400);
    expect((await api("/api/tree?path=examples/../../etc/passwd.tree.json")).status).toBe(400);
  });

  it("drafts a tree with an estimate", async () => {
    const r = await api<{ tree: { root: { mode: string } }; estimate: { total: { low: number; high: number } }; drafted: { costNanos: number } }>(
      "/api/plan",
      { goal: "Compare three note-taking apps for a small team.", panel: "starter" },
    );
    expect(r.status).toBe(200);
    expect(r.json.tree.root.mode).toBe("sequence");
    expect(r.json.estimate.total.low).toBeGreaterThan(0);
    expect(r.json.drafted.costNanos).toBeGreaterThan(0);
  });

  it("checks an edited tree and reports problems without failing the request", async () => {
    const ok = await api<{ ok: boolean; estimate?: unknown }>("/api/check", { panel: "starter", tree: { goal: "g", root: { role: "writer" } } });
    expect(ok.json).toMatchObject({ ok: true });
    const bad = await api<{ ok: boolean; error: string }>("/api/check", { panel: "starter", tree: { goal: "g", root: { role: "critic" } } });
    expect(bad.status).toBe(200);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/its job is critique/);
  });

  it("saves a tree under plans/", async () => {
    const r = await api<{ path: string }>("/api/trees", { tree: { goal: "Write a haiku about queues", root: { role: "writer" } } });
    expect(r.json.path).toBe("plans/write-a-haiku-about-queues.tree.json");
    expect(existsSync(join(root, r.json.path))).toBe(true);
  });

  it("runs a tree and streams its events, replaying from any point", async () => {
    const tree = (await api<{ tree: unknown }>("/api/tree?path=examples/vector-dbs.tree.json")).json.tree;
    const created = await api<{ runId: string }>("/api/runs", { tree, panel: "starter", capUsd: 0.5 });
    expect(created.status).toBe(200);
    const { runId } = created.json;

    const events = await stream(runId, (e) => e.type === "run.done");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const state = emptyState(runId);
    for (const e of events) apply(state, e);
    expect(state.status).toBe("done");

    // A reconnect gets only what it hasn't seen.
    const tail = await stream(runId, (e) => e.type === "run.done", events.length - 3);
    expect(tail.map((e) => e.seq)).toEqual([events.length - 2, events.length - 1, events.length]);

    const runs = await api<{ runId: string; status: string }[]>("/api/runs");
    expect(runs.json.find((r) => r.runId === runId)?.status).toBe("done");
  });

  it("pauses and resumes a run", async () => {
    const tree = { goal: "g", root: { items: ["a", "b", "c", "d", "e", "f"], template: { role: "researcher" } } };
    const { runId } = (await api<{ runId: string }>("/api/runs", { tree, panel: "starter", capUsd: 0.5, concurrency: 1 })).json;
    await api(`/api/runs/${runId}/pause`, {});
    const paused = await stream(runId, (e) => e.type === "run.paused");
    expect(paused.at(-1)).toMatchObject({ type: "run.paused", reason: "paused from the browser" });
    await api(`/api/runs/${runId}/resume`, { capUsd: 1 });
    const rest = await stream(runId, (e) => e.type === "run.done", paused.at(-1)!.seq);
    // The call in flight at the pause still finishes before the resume.
    expect(rest.find((e) => e.type === "run.resumed")).toMatchObject({ cap: 1_000_000_000 });
    expect(rest.at(-1)!.type).toBe("run.done");
  });

  it("rejects a bad cap and an unknown panel", async () => {
    expect((await api("/api/runs", { tree: { goal: "g", root: {} }, panel: "starter", capUsd: 0 })).status).toBe(400);
    expect((await api("/api/runs", { tree: { goal: "g", root: {} }, panel: "nope", capUsd: 1 })).status).toBe(404);
    expect((await api("/api/runs", { tree: { goal: "g", root: {} }, panel: "../x", capUsd: 1 })).status).toBe(400);
  });
});

import type { TreeEstimate } from "orch/src/core/estimate.ts";
import type { Drafted } from "orch/src/core/events.ts";
import type { Panel } from "orch/src/core/panel.ts";
import type { Limits } from "orch/src/core/tree.ts";

// Calls to the engine service (`orch serve`), proxied under /api.

export interface Config {
  gateway: string;
  limits: Limits;
  planCapUsd: number;
}

export interface PanelEntry {
  name: string;
  panel: Panel;
}

export interface ExampleGoal {
  id: string;
  goal: string;
  expect: string;
}

export interface Examples {
  goals: ExampleGoal[];
  trees: { path: string; goal: string }[];
}

export interface RunListItem {
  runId: string;
  goal: string;
  createdAt: string;
  status: string;
  spentNanos: number;
  cap: number;
  gateway: string;
}

export interface PlanResponse {
  tree: unknown;
  estimate: TreeEstimate;
  drafted: Drafted;
}

export type CheckResponse = { ok: true; estimate: TreeEstimate } | { ok: false; error: string };

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? "the engine sent something that isn't JSON" : `the engine isn't answering (HTTP ${res.status}). Is \`pnpm serve\` running?`);
  }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { cache: "no-store" }));
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

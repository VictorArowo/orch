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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, res.ok ? "The engine sent something that isn't JSON." : `The engine isn't answering (HTTP ${res.status}). Is it running?`);
  }
  if (!res.ok) throw new ApiError(res.status, sentence((json as { error?: string }).error ?? `HTTP ${res.status}`));
  return json as T;
}

// The engine writes errors in lower case to fit into sentences; the web
// app shows them on their own.
function sentence(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { cache: "no-store" }));
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

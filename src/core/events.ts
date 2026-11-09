import type { Nanos } from "./money.ts";
import type { Panel } from "./panel.ts";
import type { Limits, StepSpec } from "./tree.ts";

// Everything that happens in a run is one of these events, appended in order.
// Run state is never stored directly: it is always folded from the log.

export type Purpose = "do" | "check" | "critique";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Vote {
  model: string;
  verdict: "pass" | "revise" | "abstain";
  notes: string[];
}

// What drafting the tree cost, when the planner made it.
export interface Drafted {
  model: string;
  costNanos: Nanos;
  attempts: number;
  repairs: string[];
}

export type AttemptReason = "initial" | "check" | "critique" | "format" | "error" | "rerun";

export type EventBody =
  | {
      type: "run.created";
      goal: string;
      root: StepSpec;
      panel: Panel;
      cap: Nanos;
      limits: Limits;
      concurrency: number;
      gateway: string;
    }
  | ({ type: "run.drafted" } & Drafted)
  | { type: "run.started" }
  | { type: "run.paused"; reason: string; neededNanos?: Nanos }
  | { type: "run.resumed"; cap?: Nanos }
  | { type: "run.done" }
  | { type: "run.stopped"; reason: string }
  | { type: "step.expanded"; stepId: string; children: StepSpec[]; requested: number }
  | {
      type: "attempt.started";
      stepId: string;
      attemptId: string;
      n: number;
      role: string;
      model: string;
      reason: AttemptReason;
      notes: string[];
      inputVersions: Record<string, string>;
    }
  | {
      type: "call.reserved";
      callId: string;
      stepId: string;
      attemptId: string;
      purpose: Purpose;
      role: string;
      model: string;
      messages: ChatMessage[];
      maxTokens: number;
      reservedNanos: Nanos;
    }
  | {
      type: "call.finished";
      callId: string;
      output: string;
      usage: Usage;
      costNanos: Nanos;
      costSource: "gateway" | "computed";
      ms: number;
    }
  // costKnown is false when the call may or may not have been billed (a crash
  // or an abort mid-call). Its whole reservation then counts as spent.
  | { type: "call.failed"; callId: string; error: string; costNanos: Nanos; costKnown: boolean }
  | { type: "attempt.output"; attemptId: string; output: string; items?: string[]; formatError?: string }
  | {
      type: "review.decided";
      attemptId: string;
      purpose: "check" | "critique";
      role: string;
      verdict: "pass" | "revise";
      notes: string[];
      votes: Vote[];
    }
  | { type: "attempt.rejected"; attemptId: string; reason: "check" | "critique" | "format"; notes: string[] }
  | { type: "step.done"; stepId: string; attemptId: string; warning?: string }
  | { type: "step.failed"; stepId: string; error: string }
  | { type: "step.blocked"; stepId: string; neededNanos: Nanos; availableNanos: Nanos }
  | { type: "step.rerun"; stepId: string; model?: string };

export type EventType = EventBody["type"];

export type RunEvent = EventBody & { runId: string; seq: number; at: string };

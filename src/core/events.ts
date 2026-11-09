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

// What can change about a step once a run has started. null clears a field.
export interface StepPatch {
  title?: string;
  instructions?: string;
  role?: string | null;
  model?: string | null;
  check?: string | null;
  critique?: string | null;
  maxRetries?: number | null;
  maxTokens?: number | null;
}

export type AttemptReason = "initial" | "check" | "critique" | "format" | "length" | "error" | "rerun";

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
      // The account that started the run, when it came from the web app.
      owner?: string;
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
  // truncated: the model hit its token limit before finishing.
  | { type: "attempt.output"; attemptId: string; output: string; items?: string[]; formatError?: string; truncated?: boolean }
  | {
      type: "review.decided";
      attemptId: string;
      purpose: "check" | "critique";
      role: string;
      verdict: "pass" | "revise";
      notes: string[];
      votes: Vote[];
    }
  | { type: "attempt.rejected"; attemptId: string; reason: "check" | "critique" | "format" | "length"; notes: string[] }
  | { type: "step.done"; stepId: string; attemptId: string; warning?: string }
  | { type: "step.failed"; stepId: string; error: string }
  | { type: "step.blocked"; stepId: string; neededNanos: Nanos; availableNanos: Nanos }
  | { type: "step.rerun"; stepId: string; model?: string }
  // Steering. Holding a step or a branch stops its work until it's released.
  | { type: "step.held"; stepId: string }
  | { type: "step.released"; stepId: string }
  // An edit applies from the step's next attempt. `template` edits the
  // template of a fan-out that hasn't made its branches yet.
  | { type: "step.edited"; stepId: string; patch: StepPatch; template?: boolean }
  // A skipped step counts as done with no output, so the steps after it go ahead.
  | { type: "step.skipped"; stepId: string };

export type EventType = EventBody["type"];

export type RunEvent = EventBody & { runId: string; seq: number; at: string };

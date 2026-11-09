import type { AttemptReason } from "./events.js";
import { defaultDoRole, findRole, ladderModel, type Role } from "./panel.js";
import { epochAttempts, type AttemptState, type RunState } from "./state.js";

// What a leaf step should do next, worked out from the event log alone. The
// engine runs one action, records the result as events, and asks again. That
// makes a step resumable after a crash at any point between calls.

export type StepAction =
  | { kind: "none" }
  | { kind: "settle-interrupted"; callIds: string[] }
  | { kind: "start-attempt"; role: Role; model: string; reason: AttemptReason; notes: string[]; n: number }
  | { kind: "do"; attempt: AttemptState; role: Role }
  | { kind: "review"; attempt: AttemptState; purpose: "check" | "critique"; role: Role }
  | { kind: "reject"; attempt: AttemptState; reason: "check" | "critique" | "format"; notes: string[] }
  | { kind: "accept"; attempt: AttemptState; warning?: string }
  | { kind: "fail"; error: string };

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_CRITIQUE_ROUNDS = 1;
export const MAX_CALL_ERRORS = 3;
export const INTERRUPTED = "interrupted";

export function doRoleFor(state: RunState, stepId: string): Role {
  const spec = state.steps[stepId]!.spec;
  return spec.role ? findRole(state.panel, spec.role)! : defaultDoRole(state.panel);
}

export function nextAction(state: RunState, stepId: string): StepAction {
  const step = state.steps[stepId]!;
  if (step.leafStatus === "done" || step.leafStatus === "failed") return { kind: "none" };
  const spec = step.spec;
  const maxRetries = spec.maxRetries ?? DEFAULT_MAX_RETRIES;
  const critiqueRounds = spec.critiqueRounds ?? DEFAULT_CRITIQUE_ROUNDS;
  const attempts = epochAttempts(state, step);
  const last = attempts[attempts.length - 1];

  if (last) {
    const open = last.callIds.filter((c) => state.calls[c]!.status === "open");
    if (open.length) return { kind: "settle-interrupted", callIds: open };
  }

  const sendBacks = attempts.filter((a) => a.rejected && a.rejected.reason !== "critique").length;
  const critiques = attempts.filter((a) => a.rejected?.reason === "critique").length;
  const role = doRoleFor(state, stepId);

  if (!last || last.status === "rejected") {
    const model = step.modelOverride ?? spec.model ?? ladderModel(role.models, sendBacks);
    const reason: AttemptReason = last ? last.rejected!.reason : step.epochStart > 0 ? "rerun" : "initial";
    return { kind: "start-attempt", role, model, reason, notes: last?.rejected?.notes ?? [], n: step.attemptIds.length + 1 };
  }

  if (last.output === undefined) {
    const errors = last.callIds
      .map((c) => state.calls[c]!)
      .filter((c) => c.purpose === "do" && c.status === "failed" && c.error !== INTERRUPTED);
    if (errors.length >= MAX_CALL_ERRORS) {
      return { kind: "fail", error: `model call failed ${errors.length} times: ${errors[errors.length - 1]!.error}` };
    }
    return { kind: "do", attempt: last, role };
  }

  if (last.formatError) {
    if (sendBacks >= maxRetries) return { kind: "fail", error: `output was malformed after ${sendBacks + 1} tries: ${last.formatError}` };
    return { kind: "reject", attempt: last, reason: "format", notes: [last.formatError] };
  }

  let warning: string | undefined;
  if (spec.check) {
    const review = last.reviews.find((r) => r.purpose === "check");
    if (!review) return { kind: "review", attempt: last, purpose: "check", role: findRole(state.panel, spec.check)! };
    if (review.verdict === "revise") {
      if (sendBacks < maxRetries) return { kind: "reject", attempt: last, reason: "check", notes: review.notes };
      warning = `accepted after ${maxRetries} send-backs; the check still asked for changes`;
    }
  }

  if (spec.critique && critiques < critiqueRounds) {
    const review = last.reviews.find((r) => r.purpose === "critique");
    if (!review) return { kind: "review", attempt: last, purpose: "critique", role: findRole(state.panel, spec.critique)! };
    if (review.verdict === "revise") return { kind: "reject", attempt: last, reason: "critique", notes: review.notes };
  }

  return warning ? { kind: "accept", attempt: last, warning } : { kind: "accept", attempt: last };
}

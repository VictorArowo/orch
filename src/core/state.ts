import type { AttemptReason, ChatMessage, Drafted, Purpose, RunEvent, Usage, Vote } from "./events.js";
import type { Nanos } from "./money.js";
import type { Panel } from "./panel.js";
import type { Limits, StepSpec } from "./tree.js";

export type RunStatus = "ready" | "running" | "paused" | "done" | "stopped";
export type StepStatus = "pending" | "running" | "blocked" | "done" | "failed";

export interface CallState {
  id: string;
  stepId: string;
  attemptId: string;
  purpose: Purpose;
  role: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  reservedNanos: Nanos;
  status: "open" | "finished" | "failed";
  output?: string;
  usage?: Usage;
  costNanos: Nanos;
  costKnown: boolean;
  error?: string;
  ms?: number;
}

export interface ReviewState {
  purpose: "check" | "critique";
  role: string;
  verdict: "pass" | "revise";
  notes: string[];
  votes: Vote[];
}

export interface AttemptState {
  id: string;
  stepId: string;
  n: number;
  role: string;
  model: string;
  reason: AttemptReason;
  notes: string[];
  inputVersions: Record<string, string>;
  callIds: string[];
  output?: string;
  items?: string[];
  formatError?: string;
  reviews: ReviewState[];
  status: "running" | "rejected" | "accepted";
  rejected?: { reason: "check" | "critique" | "format"; notes: string[] };
}

export interface StepState {
  id: string;
  spec: StepSpec;
  parentId?: string;
  childIds: string[];
  depth: number;
  // Leaf bookkeeping. A re-run starts a new epoch: older attempts are kept for
  // comparison but no longer count towards retries.
  leafStatus: "pending" | "running" | "done" | "failed";
  attemptIds: string[];
  epochStart: number;
  acceptedAttemptId?: string;
  modelOverride?: string;
  warning?: string;
  error?: string;
  blocked?: { neededNanos: Nanos; availableNanos: Nanos };
  // For parallel steps that fan out over another step's output.
  expanded: boolean;
}

export interface RunState {
  runId: string;
  goal: string;
  status: RunStatus;
  reason?: string;
  neededNanos?: Nanos;
  cap: Nanos;
  limits: Limits;
  concurrency: number;
  panel: Panel;
  gateway: string;
  rootId: string;
  steps: Record<string, StepState>;
  order: string[];
  attempts: Record<string, AttemptState>;
  calls: Record<string, CallState>;
  spentNanos: Nanos;
  reservedNanos: Nanos;
  drafted?: Drafted;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export function emptyState(runId: string): RunState {
  return {
    runId,
    goal: "",
    status: "ready",
    cap: 0,
    limits: { maxDepth: 0, maxFanOut: 0, maxSteps: 0 },
    concurrency: 1,
    panel: { name: "", roles: [] },
    gateway: "",
    rootId: "",
    steps: {},
    order: [],
    attempts: {},
    calls: {},
    spentNanos: 0,
    reservedNanos: 0,
    lastSeq: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function addStep(state: RunState, spec: StepSpec, parentId: string | undefined, depth: number) {
  const step: StepState = {
    id: spec.id,
    spec,
    childIds: spec.children.map((c) => c.id),
    depth,
    leafStatus: "pending",
    attemptIds: [],
    epochStart: 0,
    expanded: !spec.itemsFrom,
  };
  if (parentId !== undefined) step.parentId = parentId;
  state.steps[spec.id] = step;
  state.order.push(spec.id);
  for (const c of spec.children) addStep(state, c, spec.id, depth + 1);
}

function mustStep(state: RunState, id: string): StepState {
  const s = state.steps[id];
  if (!s) throw new Error(`event refers to unknown step "${id}"`);
  return s;
}

function mustAttempt(state: RunState, id: string): AttemptState {
  const a = state.attempts[id];
  if (!a) throw new Error(`event refers to unknown attempt "${id}"`);
  return a;
}

function mustCall(state: RunState, id: string): CallState {
  const c = state.calls[id];
  if (!c) throw new Error(`event refers to unknown call "${id}"`);
  return c;
}

// Fold one event into the state. Mutates and returns `state`.
export function apply(state: RunState, e: RunEvent): RunState {
  if (e.seq !== state.lastSeq + 1) throw new Error(`event ${e.seq} applied after ${state.lastSeq}`);
  state.lastSeq = e.seq;
  state.updatedAt = e.at;
  switch (e.type) {
    case "run.created":
      state.goal = e.goal;
      state.panel = e.panel;
      state.cap = e.cap;
      state.limits = e.limits;
      state.concurrency = e.concurrency;
      state.gateway = e.gateway;
      state.rootId = e.root.id;
      state.createdAt = e.at;
      addStep(state, e.root, undefined, 1);
      break;
    case "run.drafted":
      state.drafted = { model: e.model, costNanos: e.costNanos, attempts: e.attempts, repairs: e.repairs };
      state.spentNanos += e.costNanos;
      break;
    case "run.started":
      state.status = "running";
      break;
    case "run.paused":
      state.status = "paused";
      state.reason = e.reason;
      if (e.neededNanos !== undefined) state.neededNanos = e.neededNanos;
      break;
    case "run.resumed":
      state.status = "running";
      delete state.reason;
      delete state.neededNanos;
      if (e.cap !== undefined) state.cap = e.cap;
      for (const s of Object.values(state.steps)) delete s.blocked;
      break;
    case "run.done":
      state.status = "done";
      delete state.reason;
      break;
    case "run.stopped":
      state.status = "stopped";
      state.reason = e.reason;
      break;
    case "step.expanded": {
      const step = mustStep(state, e.stepId);
      step.expanded = true;
      step.childIds = e.children.map((c) => c.id);
      for (const c of e.children) addStep(state, c, step.id, step.depth + 1);
      break;
    }
    case "attempt.started": {
      const step = mustStep(state, e.stepId);
      state.attempts[e.attemptId] = {
        id: e.attemptId,
        stepId: e.stepId,
        n: e.n,
        role: e.role,
        model: e.model,
        reason: e.reason,
        notes: e.notes,
        inputVersions: e.inputVersions,
        callIds: [],
        reviews: [],
        status: "running",
      };
      step.attemptIds.push(e.attemptId);
      step.leafStatus = "running";
      delete step.blocked;
      break;
    }
    case "call.reserved": {
      state.calls[e.callId] = {
        id: e.callId,
        stepId: e.stepId,
        attemptId: e.attemptId,
        purpose: e.purpose,
        role: e.role,
        model: e.model,
        messages: e.messages,
        maxTokens: e.maxTokens,
        reservedNanos: e.reservedNanos,
        status: "open",
        costNanos: 0,
        costKnown: false,
      };
      mustAttempt(state, e.attemptId).callIds.push(e.callId);
      state.reservedNanos += e.reservedNanos;
      break;
    }
    case "call.finished": {
      const call = mustCall(state, e.callId);
      call.status = "finished";
      call.output = e.output;
      call.usage = e.usage;
      call.costNanos = e.costNanos;
      call.costKnown = true;
      call.ms = e.ms;
      state.reservedNanos -= call.reservedNanos;
      state.spentNanos += e.costNanos;
      break;
    }
    case "call.failed": {
      const call = mustCall(state, e.callId);
      call.status = "failed";
      call.error = e.error;
      call.costNanos = e.costNanos;
      call.costKnown = e.costKnown;
      state.reservedNanos -= call.reservedNanos;
      state.spentNanos += e.costNanos;
      break;
    }
    case "attempt.output": {
      const a = mustAttempt(state, e.attemptId);
      a.output = e.output;
      if (e.items) a.items = e.items;
      if (e.formatError) a.formatError = e.formatError;
      break;
    }
    case "review.decided":
      mustAttempt(state, e.attemptId).reviews.push({
        purpose: e.purpose,
        role: e.role,
        verdict: e.verdict,
        notes: e.notes,
        votes: e.votes,
      });
      break;
    case "attempt.rejected": {
      const a = mustAttempt(state, e.attemptId);
      a.status = "rejected";
      a.rejected = { reason: e.reason, notes: e.notes };
      break;
    }
    case "step.done": {
      const step = mustStep(state, e.stepId);
      step.leafStatus = "done";
      step.acceptedAttemptId = e.attemptId;
      mustAttempt(state, e.attemptId).status = "accepted";
      if (e.warning) step.warning = e.warning;
      break;
    }
    case "step.failed": {
      const step = mustStep(state, e.stepId);
      step.leafStatus = "failed";
      step.error = e.error;
      break;
    }
    case "step.blocked":
      mustStep(state, e.stepId).blocked = { neededNanos: e.neededNanos, availableNanos: e.availableNanos };
      break;
    case "step.rerun": {
      const step = mustStep(state, e.stepId);
      step.epochStart = step.attemptIds.length;
      step.leafStatus = "pending";
      delete step.acceptedAttemptId;
      delete step.warning;
      delete step.error;
      delete step.blocked;
      if (e.model) step.modelOverride = e.model;
      else delete step.modelOverride;
      break;
    }
  }
  return state;
}

export function fold(runId: string, events: RunEvent[]): RunState {
  const state = emptyState(runId);
  for (const e of events) apply(state, e);
  return state;
}

// ---- Derived views ----

export function isLeaf(step: StepState): boolean {
  return step.spec.mode === "leaf";
}

export function children(state: RunState, id: string): StepState[] {
  return state.steps[id]!.childIds.map((c) => state.steps[c]!);
}

export function epochAttempts(state: RunState, step: StepState): AttemptState[] {
  return step.attemptIds.slice(step.epochStart).map((a) => state.attempts[a]!);
}

export function stepStatus(state: RunState, id: string): StepStatus {
  const step = state.steps[id]!;
  if (isLeaf(step)) {
    if (step.blocked && (step.leafStatus === "pending" || step.leafStatus === "running")) return "blocked";
    return step.leafStatus;
  }
  if (!step.expanded) return "pending";
  const kids = step.childIds.map((c) => stepStatus(state, c));
  if (kids.every((k) => k === "done")) return "done";
  if (kids.some((k) => k === "failed")) return "failed";
  if (kids.some((k) => k === "running" || k === "done")) return "running";
  if (kids.some((k) => k === "blocked")) return "blocked";
  return "pending";
}

// Steps whose output this step reads.
export function inputIds(state: RunState, id: string): string[] {
  const step = state.steps[id]!;
  if (step.spec.inputs) return step.spec.inputs;
  if (step.parentId === undefined) return [];
  const parent = state.steps[step.parentId]!;
  const idx = parent.childIds.indexOf(id);
  if (parent.spec.mode === "sequence" && idx > 0) return [parent.childIds[idx - 1]!];
  return inputIds(state, parent.id);
}

// Steps that must be done before this one can start: its inputs, and for it
// and each ancestor sitting in a sequence, the previous sibling.
export function blockers(state: RunState, id: string): string[] {
  const out = new Set<string>(inputIds(state, id));
  let cur: StepState | undefined = state.steps[id];
  while (cur && cur.parentId !== undefined) {
    const parent: StepState = state.steps[cur.parentId]!;
    for (const i of cur.spec.inputs ?? []) out.add(i);
    const idx = parent.childIds.indexOf(cur.id);
    if (parent.spec.mode === "sequence" && idx > 0) out.add(parent.childIds[idx - 1]!);
    if (parent.spec.itemsFrom) out.add(parent.spec.itemsFrom);
    cur = parent;
  }
  return [...out];
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// A version names the exact output a step currently provides: the accepted
// attempt for a leaf, and a hash of its children's versions for a composite.
export function versionOf(state: RunState, id: string): string {
  const step = state.steps[id]!;
  if (isLeaf(step)) return step.acceptedAttemptId ?? "";
  return "v" + fnv1a(step.childIds.map((c) => `${c}=${versionOf(state, c)}`).join(";"));
}

// A done step is stale when an input it read has since changed, or is stale itself.
export function isStale(state: RunState, id: string, memo = new Map<string, boolean>()): boolean {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  memo.set(id, false);
  const step = state.steps[id]!;
  let stale = false;
  if (isLeaf(step)) {
    const accepted = step.acceptedAttemptId ? state.attempts[step.acceptedAttemptId] : undefined;
    if (accepted) {
      for (const [input, version] of Object.entries(accepted.inputVersions)) {
        if (versionOf(state, input) !== version || isStale(state, input, memo)) {
          stale = true;
          break;
        }
      }
    }
  } else {
    stale = step.childIds.some((c) => isStale(state, c, memo));
  }
  memo.set(id, stale);
  return stale;
}

export function outputOf(state: RunState, id: string): string {
  const step = state.steps[id]!;
  if (isLeaf(step)) return step.acceptedAttemptId ? (state.attempts[step.acceptedAttemptId]!.output ?? "") : "";
  if (step.spec.mode === "sequence") {
    const last = step.childIds[step.childIds.length - 1];
    return last ? outputOf(state, last) : "";
  }
  return step.childIds.map((c) => `### ${state.steps[c]!.spec.title}\n\n${outputOf(state, c)}`).join("\n\n");
}

export function stepCost(state: RunState, id: string): Nanos {
  const step = state.steps[id]!;
  if (!isLeaf(step)) return step.childIds.reduce((sum, c) => sum + stepCost(state, c), 0);
  let total = 0;
  for (const a of step.attemptIds) for (const c of state.attempts[a]!.callIds) total += state.calls[c]!.costNanos;
  return total;
}

// Step ids in tree order (depth first), including fan-out children.
export function treeOrder(state: RunState): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    out.push(id);
    for (const c of state.steps[id]!.childIds) visit(c);
  };
  if (state.rootId) visit(state.rootId);
  return out;
}

// Find a dependency cycle (a step that would wait on itself), if any.
export function findCycle(state: RunState): string[] | null {
  const waitsFor = (id: string): string[] => {
    const step = state.steps[id]!;
    if (isLeaf(step)) return blockers(state, id);
    return [...step.childIds, ...(step.spec.itemsFrom ? [step.spec.itemsFrom] : [])];
  };
  const color = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (color.get(id) === 2) return null;
    if (color.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    color.set(id, 1);
    path.push(id);
    for (const next of waitsFor(id)) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of state.order) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

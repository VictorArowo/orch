import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { decide, worstCase } from "../core/budget.ts";
import { checkTree } from "../core/check-tree.ts";
import type { ChatMessage, Drafted, EventBody, Purpose, RunEvent, Vote } from "../core/events.ts";
import { costOf, type Nanos } from "../core/money.ts";
import { modelsOf, type Panel, type Role } from "../core/panel.ts";
import { checkMessages, critiqueMessages, doMessages, parseList, parseObjections, parseVerdict, tally } from "../core/prompt.ts";
import {
  blockers,
  emptyState,
  apply,
  epochAttempts,
  inputIds,
  isLeaf,
  outputOf,
  stepStatus,
  versionOf,
  type AttemptState,
  type RunState,
} from "../core/state.ts";
import { INTERRUPTED, nextAction } from "../core/step-machine.ts";
import { DEFAULT_LIMITS, expandTemplate, walk, type Limits, type Tree } from "../core/tree.ts";
import { GatewayError, type Gateway } from "../gateway/gateway.ts";
import { redact } from "../gateway/redact.ts";
import { LostLeaseError, type Job, type LockedContext, type LockedWrite, type Store } from "../store/store.ts";

export interface EngineOptions {
  store: Store;
  // One gateway for every run, or one per account (so each user's runs use
  // their own key).
  gateway: Gateway | ((owner: string | undefined) => Gateway);
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  // Delay before retrying a failed model call, multiplied by the error count.
  retryBackoffMs?: number;
  // Decides whether another worker's id belongs to a process that has died.
  isWorkerDead?: (workerId: string) => boolean;
}

export interface CreateRunOptions {
  tree: Tree;
  panel: Panel;
  capNanos: Nanos;
  limits?: Partial<Limits>;
  concurrency?: number;
  // Set when the tree came from the planner in the same command.
  drafted?: Drafted;
  // The account starting the run, when it comes from the web app.
  owner?: string;
}

class Killed extends Error {}

interface PlannedCall {
  purpose: Purpose;
  role: Role;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
}

const DEFAULT_DO_TOKENS = 1024;
const DEFAULT_REVIEW_TOKENS = 512;

export function newWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

// A worker on this machine whose process no longer exists is dead.
export function localWorkerIsDead(workerId: string): boolean {
  const [host, pidText] = workerId.split(":");
  const pid = Number(pidText);
  if (host !== hostname() || !Number.isInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// The engine owns the scheduler and the per-step loop. Any number of engines
// (in one process or several) can work on the same run: decisions are made
// under the run's lock in the store, and work is handed out as queued jobs.
export class Engine extends EventEmitter<{ event: [RunEvent] }> {
  readonly workerId: string;
  private readonly store: Store;
  private readonly gatewayFor: (owner: string | undefined) => Gateway;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly retryBackoffMs: number;
  private readonly isWorkerDead: (id: string) => boolean;
  private readonly cache = new Map<string, RunState>();
  private killed = false;
  private wake: (() => void)[] = [];

  constructor(opts: EngineOptions) {
    super();
    this.store = opts.store;
    const g = opts.gateway;
    this.gatewayFor = typeof g === "function" ? g : () => g;
    this.workerId = opts.workerId ?? newWorkerId();
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 100;
    this.retryBackoffMs = opts.retryBackoffMs ?? 1_000;
    this.isWorkerDead = opts.isWorkerDead ?? localWorkerIsDead;
  }

  // ---- Commands ----

  async createRun(opts: CreateRunOptions): Promise<string> {
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const { models } = checkTree(opts.tree, opts.panel, limits);
    // Every model must have a known price before anything runs, or the cap
    // can't be enforced. This also catches typos in model ids.
    const gateway = this.gatewayFor(opts.owner);
    for (const m of models) await gateway.price(m);
    if (opts.drafted && opts.drafted.costNanos > opts.capNanos) throw new Error("planning already spent more than the cap");
    const created: EventBody = {
      type: "run.created",
      goal: opts.tree.goal,
      root: opts.tree.root,
      panel: opts.panel,
      cap: opts.capNanos,
      limits,
      concurrency: Math.max(1, opts.concurrency ?? 4),
      gateway: gateway.name,
    };
    if (opts.owner) created.owner = opts.owner;
    const runId = newRunId();
    this.guard();
    const first = await this.store.createRun(runId, created);
    this.ingest(runId, [first]);
    // Planning happened before the run existed; its cost still counts against the cap.
    if (opts.drafted) {
      const drafted = opts.drafted;
      await this.locked(runId, () => ({ events: [{ type: "run.drafted", ...drafted }] }));
    }
    return runId;
  }

  async start(runId: string): Promise<void> {
    await this.locked(runId, (s) => ({ events: s.status === "ready" ? [{ type: "run.started" }] : [] }));
    await this.tick(runId);
  }

  async pause(runId: string, reason: string): Promise<void> {
    await this.locked(runId, (s) =>
      s.status === "running" ? { events: [{ type: "run.paused", reason }], cancelQueued: true } : { events: [] },
    );
    this.notify();
  }

  // Pick a paused or stopped run back up, optionally with a new cap. Jobs held
  // by workers that have died are handed back straight away.
  async resume(runId: string, opts: { capNanos?: Nanos } = {}): Promise<void> {
    const state = await this.refresh(runId);
    if (state.status === "ready") return this.start(runId);
    this.guard();
    await this.store.reclaimJobs(runId, this.isWorkerDead);
    await this.locked(runId, (s) => {
      if (s.status === "done" && opts.capNanos === undefined) return { events: [] };
      const resumed: EventBody = { type: "run.resumed" };
      if (opts.capNanos !== undefined) resumed.cap = opts.capNanos;
      return { events: [resumed] };
    });
    await this.tick(runId);
  }

  // Run a leaf again, optionally on another model. Steps that read its old
  // output become stale; they are left alone unless re-run too.
  async rerun(runId: string, stepIds: string[], opts: { model?: string } = {}): Promise<void> {
    if (opts.model) await this.gatewayFor((await this.refresh(runId)).owner).price(opts.model);
    await this.locked(runId, (s) => {
      const events: EventBody[] = [];
      for (const id of stepIds) {
        const step = s.steps[id];
        if (!step) throw new Error(`no step "${id}" in run ${runId}`);
        if (!isLeaf(step)) throw new Error(`"${id}" is a ${step.spec.mode} step; re-run its leaves instead`);
        if (step.leafStatus !== "done" && step.leafStatus !== "failed") throw new Error(`"${id}" hasn't finished yet`);
        const e: EventBody = { type: "step.rerun", stepId: id };
        if (opts.model) e.model = opts.model;
        events.push(e);
      }
      if (s.status !== "running") events.push({ type: "run.resumed" });
      return { events };
    });
    await this.tick(runId);
  }

  // Work on a run until it is done, paused or stopped. By default this engine
  // runs as many worker loops as the run's concurrency allows; other engines
  // can work on the same run at the same time.
  async drive(runId: string, opts: { workers?: number } = {}): Promise<RunState> {
    const state = await this.refresh(runId);
    const loops = Array.from({ length: opts.workers ?? state.concurrency }, () => this.workerLoop(runId));
    await Promise.all(loops);
    return this.refresh(runId);
  }

  // Simulate a crash: stop touching the store at once, without cleaning up.
  kill(): void {
    this.killed = true;
    this.notify();
  }

  async state(runId: string): Promise<RunState> {
    return this.refresh(runId);
  }

  // ---- State cache ----

  private ingest(runId: string, events: RunEvent[]): RunState {
    let state = this.cache.get(runId);
    if (!state) {
      state = emptyState(runId);
      this.cache.set(runId, state);
    }
    for (const e of events) {
      if (e.seq <= state.lastSeq) continue;
      apply(state, e);
      this.emit("event", e);
    }
    return state;
  }

  private async refresh(runId: string): Promise<RunState> {
    this.guard();
    const lastSeq = this.cache.get(runId)?.lastSeq ?? 0;
    const events = await this.store.readEvents(runId, lastSeq);
    const state = this.ingest(runId, events);
    if (state.lastSeq === 0) throw new Error(`no run "${runId}"`);
    return state;
  }

  private guard() {
    if (this.killed) throw new Killed("engine was killed");
  }

  private async locked<T = undefined>(
    runId: string,
    fn: (state: RunState, ctx: LockedContext) => LockedWrite & { result?: T },
    fence?: Job,
  ): Promise<{ appended: RunEvent[]; result: T | undefined }> {
    this.guard();
    const afterSeq = this.cache.get(runId)?.lastSeq ?? 0;
    const out = await this.store.withRunLock<T | undefined>(
      runId,
      afterSeq,
      (ctx) => {
        this.guard();
        const state = this.ingest(runId, ctx.newEvents);
        const { result, ...write } = fn(state, ctx);
        return { write, result };
      },
      fence ? { jobId: fence.id, workerId: this.workerId } : undefined,
    );
    this.ingest(runId, out.appended);
    if (out.appended.length) this.notify();
    return out;
  }

  // ---- Scheduler ----

  // Expand fan-outs whose lists are ready, queue ready leaves up to the
  // concurrency limit, and settle the run when nothing is left to do.
  async tick(runId: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const { appended } = await this.locked(runId, (s, ctx) => this.plan(s, ctx));
      if (!appended.some((e) => e.type === "step.expanded")) return;
    }
  }

  private plan(s: RunState, ctx: LockedContext): LockedWrite {
    if (s.status !== "running") return { events: [] };

    const expansions: EventBody[] = [];
    let stepCount = s.order.length;
    for (const id of s.order) {
      const step = s.steps[id]!;
      const from = step.spec.itemsFrom;
      if (step.expanded || !from || stepStatus(s, from) !== "done") continue;
      const source = s.steps[from]!;
      const items = s.attempts[source.acceptedAttemptId!]!.items ?? [];
      let size = 0;
      walk(step.spec.template!, () => size++);
      const room = Math.max(0, Math.floor((s.limits.maxSteps - stepCount) / Math.max(1, size)));
      const kept = items.slice(0, Math.min(s.limits.maxFanOut, room));
      const children = expandTemplate(step.spec, kept);
      stepCount += kept.length * size;
      expansions.push({ type: "step.expanded", stepId: id, children, requested: items.length });
    }
    if (expansions.length) return { events: expansions };

    const ready: string[] = [];
    for (const id of s.order) {
      const step = s.steps[id]!;
      if (!isLeaf(step) || step.blocked || ctx.activeStepIds.has(id)) continue;
      if (step.leafStatus !== "pending" && step.leafStatus !== "running") continue;
      if (blockers(s, id).every((b) => stepStatus(s, b) === "done")) ready.push(id);
    }
    const slots = Math.max(0, s.concurrency - ctx.activeJobs);
    const enqueue = ready.slice(0, slots);
    if (enqueue.length || ctx.activeJobs > 0) return { events: [], enqueue };

    if (stepStatus(s, s.rootId) === "done") return { events: [{ type: "run.done" }] };
    const blocked = Object.values(s.steps).filter((x) => x.blocked);
    if (blocked.length) {
      const needed = Math.max(...blocked.map((b) => b.blocked!.neededNanos));
      return {
        events: [{ type: "run.paused", reason: "budget: the next call doesn't fit under the cap", neededNanos: needed }],
      };
    }
    const failed = Object.values(s.steps).filter((x) => isLeaf(x) && x.leafStatus === "failed");
    const reason = failed.length
      ? `${failed.length} step${failed.length > 1 ? "s" : ""} failed: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}`
      : "no step can run";
    return { events: [{ type: "run.stopped", reason }] };
  }

  // ---- Workers ----

  private async workerLoop(runId: string): Promise<void> {
    let lastTick = 0;
    try {
      while (!this.killed) {
        const job = await this.store.claimJob(runId, this.workerId, this.leaseMs);
        this.guard();
        if (job) {
          await this.runJob(job);
          continue;
        }
        const state = await this.refresh(runId);
        if (state.status !== "running") return;
        if (Date.now() - lastTick > 500) {
          lastTick = Date.now();
          await this.tick(runId);
        }
        await this.idle();
      }
    } catch (err) {
      if (err instanceof Killed) return;
      throw err;
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, this.pollMs);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = self.wake.filter((w) => w !== done);
        resolve();
      }
      this.wake.push(done);
    });
  }

  private notify() {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  private async runJob(job: Job): Promise<void> {
    let lost = false;
    const beat = setInterval(() => {
      if (this.killed) return;
      this.store.heartbeat(job.id, this.workerId, this.leaseMs).then(
        (ok) => (lost ||= !ok),
        () => {},
      );
    }, Math.max(50, this.leaseMs / 3));
    try {
      for (;;) {
        if (lost) throw new LostLeaseError(job.id);
        const state = await this.refresh(job.runId);
        if (state.status !== "running") {
          await this.store.finishJob(job.id, this.workerId, "cancelled");
          return;
        }
        const outcome = await this.step(job, state);
        if (outcome === "continue") continue;
        this.guard();
        if (outcome === "wait") {
          await this.store.releaseJob(job.id, this.workerId, 200);
        } else {
          await this.store.finishJob(job.id, this.workerId, outcome === "blocked" ? "cancelled" : "done");
          await this.tick(job.runId);
        }
        return;
      }
    } catch (err) {
      if (err instanceof LostLeaseError || err instanceof Killed) return;
      throw err;
    } finally {
      clearInterval(beat);
    }
  }

  // Take one action for a leaf. Returns whether the job should keep going.
  private async step(job: Job, state: RunState): Promise<"continue" | "finished" | "wait" | "blocked"> {
    const stepId = job.stepId;
    const action = nextAction(state, stepId);
    const spec = state.steps[stepId]!.spec;

    switch (action.kind) {
      case "none":
        return "finished";

      case "settle-interrupted":
        // We can't know whether an interrupted call was billed, so its whole
        // worst-case reservation counts as spent.
        await this.locked(
          job.runId,
          (s) => ({
            events: action.callIds.map((callId) => ({
              type: "call.failed" as const,
              callId,
              error: INTERRUPTED,
              costNanos: s.calls[callId]!.reservedNanos,
              costKnown: false,
            })),
          }),
          job,
        );
        return "continue";

      case "start-attempt": {
        const versions: Record<string, string> = {};
        for (const input of inputIds(state, stepId)) versions[input] = versionOf(state, input);
        await this.locked(
          job.runId,
          () => ({
            events: [
              {
                type: "attempt.started",
                stepId,
                attemptId: `${stepId}#${action.n}`,
                n: action.n,
                role: action.role.name,
                model: action.model,
                reason: action.reason,
                notes: action.notes,
                inputVersions: versions,
              },
            ],
          }),
          job,
        );
        return "continue";
      }

      case "do": {
        const a = action.attempt;
        const step = state.steps[stepId]!;
        const previous = epochAttempts(state, step).filter((x) => x.id !== a.id).pop();
        const inputs = Object.keys(a.inputVersions).map((id) => ({
          stepId: id,
          title: state.steps[id]!.spec.title,
          output: outputOf(state, id),
        }));
        const msgOpts: Parameters<typeof doMessages>[0] = { role: action.role, goal: state.goal, step: spec, inputs, notes: a.notes };
        if (a.notes.length && previous?.output) msgOpts.previousOutput = previous.output;
        const call: PlannedCall = {
          purpose: "do",
          role: action.role,
          model: a.model,
          messages: doMessages(msgOpts),
          maxTokens: spec.maxTokens ?? action.role.settings.maxTokens ?? DEFAULT_DO_TOKENS,
        };
        const result = await this.callModels(job, a, [call]);
        if (result.kind !== "done") return result.kind;
        const r = result.results[0]!;
        if (!r.ok) {
          if (!r.retryable) {
            await this.locked(job.runId, () => ({ events: [{ type: "step.failed", stepId, error: r.error }] }), job);
            return "finished";
          }
          const errors = a.callIds.length;
          await sleep(this.retryBackoffMs * errors);
          return "continue";
        }
        const out: EventBody = { type: "attempt.output", attemptId: a.id, output: r.text };
        if (spec.output === "list") {
          try {
            out.items = parseList(r.text);
          } catch (err) {
            out.formatError = `expected a JSON list of strings: ${(err as Error).message}`;
          }
        }
        await this.locked(job.runId, () => ({ events: [out] }), job);
        return "continue";
      }

      case "review": {
        const a = action.attempt;
        const output = a.output ?? "";
        const build = action.purpose === "check" ? checkMessages : critiqueMessages;
        const messages = build({ role: action.role, goal: state.goal, step: spec, output });
        const calls: PlannedCall[] = modelsOf(action.role.models).map((model) => ({
          purpose: action.purpose,
          role: action.role,
          model,
          messages,
          maxTokens: action.role.settings.maxTokens ?? DEFAULT_REVIEW_TOKENS,
        }));
        const result = await this.callModels(job, a, calls);
        if (result.kind !== "done") return result.kind;
        const votes: Vote[] = result.results.map((r, i) => {
          const model = calls[i]!.model;
          if (!r.ok) return { model, verdict: "abstain", notes: [`call failed: ${r.error}`] };
          return action.purpose === "check" ? parseVerdict(model, r.text) : parseObjections(model, r.text);
        });
        const { verdict, notes } = tally(votes);
        await this.locked(
          job.runId,
          () => ({
            events: [{ type: "review.decided", attemptId: a.id, purpose: action.purpose, role: action.role.name, verdict, notes, votes }],
          }),
          job,
        );
        return "continue";
      }

      case "reject":
        await this.locked(
          job.runId,
          () => ({ events: [{ type: "attempt.rejected", attemptId: action.attempt.id, reason: action.reason, notes: action.notes }] }),
          job,
        );
        return "continue";

      case "accept": {
        const done: EventBody = { type: "step.done", stepId, attemptId: action.attempt.id };
        if (action.warning) done.warning = action.warning;
        await this.locked(job.runId, () => ({ events: [done] }), job);
        return "finished";
      }

      case "fail":
        await this.locked(job.runId, () => ({ events: [{ type: "step.failed", stepId, error: action.error }] }), job);
        return "finished";
    }
  }

  // Reserve the worst case for every call under the cap, make the calls in
  // parallel, then reconcile each reservation to what the call really cost.
  private async callModels(
    job: Job,
    attempt: AttemptState,
    calls: PlannedCall[],
  ): Promise<
    | { kind: "wait" | "blocked" }
    | { kind: "done"; results: ({ ok: true; text: string } | { ok: false; error: string; retryable: boolean })[] }
  > {
    const gateway = this.gatewayFor(this.cache.get(job.runId)!.owner);
    const prices = await Promise.all(calls.map((c) => gateway.price(c.model)));
    const amounts = calls.map((c, i) => worstCase(prices[i]!, c.messages, c.maxTokens));
    const total = amounts.reduce((a, b) => a + b, 0);
    const base = attempt.callIds.length;
    const callIds = calls.map((c, i) => `${attempt.id}/${c.purpose}${base + i + 1}`);

    const { result: decision } = await this.locked<"ok" | "wait" | "blocked">(
      job.runId,
      (s) => {
        const d = decide({ cap: s.cap, spentNanos: s.spentNanos, reservedNanos: s.reservedNanos }, total);
        if (d.kind === "wait") return { events: [], result: "wait" };
        if (d.kind === "blocked") {
          return {
            events: [{ type: "step.blocked", stepId: job.stepId, neededNanos: total, availableNanos: d.availableNanos }],
            result: "blocked",
          };
        }
        return {
          events: calls.map((c, i) => ({
            type: "call.reserved" as const,
            callId: callIds[i]!,
            stepId: job.stepId,
            attemptId: attempt.id,
            purpose: c.purpose,
            role: c.role.name,
            model: c.model,
            messages: c.messages,
            maxTokens: c.maxTokens,
            reservedNanos: amounts[i]!,
          })),
          result: "ok",
        };
      },
      job,
    );
    if (decision !== "ok") return { kind: decision! };

    const settled = await Promise.all(
      calls.map(async (c, i) => {
        const started = Date.now();
        try {
          const res = await gateway.complete({
            model: c.model,
            messages: c.messages,
            maxTokens: c.maxTokens,
            settings: c.role.settings,
            meta: { purpose: c.purpose, stepId: job.stepId, output: this.cache.get(job.runId)!.steps[job.stepId]!.spec.output },
          });
          const event: EventBody = {
            type: "call.finished",
            callId: callIds[i]!,
            output: res.text,
            usage: res.usage,
            costNanos: res.costNanos ?? costOf(prices[i]!, res.usage.promptTokens, res.usage.completionTokens),
            costSource: res.costNanos !== undefined ? "gateway" : "computed",
            ms: Date.now() - started,
          };
          return { event, result: { ok: true as const, text: res.text } };
        } catch (err) {
          if (err instanceof Killed) throw err;
          const error = redact(err instanceof Error ? err.message : String(err));
          const retryable = err instanceof GatewayError ? err.retryable : true;
          const event: EventBody = { type: "call.failed", callId: callIds[i]!, error, costNanos: 0, costKnown: true };
          return { event, result: { ok: false as const, error, retryable } };
        }
      }),
    );
    await this.locked(job.runId, () => ({ events: settled.map((x) => x.event) }), job);
    return { kind: "done", results: settled.map((x) => x.result) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

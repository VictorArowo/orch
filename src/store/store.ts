import type { EventBody, RunEvent } from "../core/events.ts";

export interface Job {
  id: number;
  runId: string;
  stepId: string;
  tries: number;
}

export interface RunSummary {
  runId: string;
  goal: string;
  createdAt: string;
  lastSeq: number;
}

// What a locked section may ask the store to do, atomically with its events.
export interface LockedWrite {
  events: EventBody[];
  enqueue?: string[];
  cancelQueued?: boolean;
}

export interface LockedContext {
  // Events appended since `afterSeq`, read after the run lock was taken.
  newEvents: RunEvent[];
  activeJobs: number;
  activeStepIds: Set<string>;
}

// The engine's only view of storage. Events are the source of truth for run
// state; jobs are the durable queue of leaf steps to work on.
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  createRun(runId: string, first: EventBody): Promise<RunEvent>;
  readEvents(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  listRuns(opts?: { owner?: string }): Promise<RunSummary[]>;
  // The account a run belongs to: null for one started from the CLI,
  // undefined when there is no such run.
  ownerOf(runId: string): Promise<string | null | undefined>;

  // Run `fn` while holding the run's lock, then append its events and apply
  // its queue changes in the same transaction. If `fence` is given, the write
  // only happens while that worker still holds that job.
  withRunLock<T>(
    runId: string,
    afterSeq: number,
    fn: (ctx: LockedContext) => Promise<{ write: LockedWrite; result: T }> | { write: LockedWrite; result: T },
    fence?: { jobId: number; workerId: string },
  ): Promise<{ appended: RunEvent[]; result: T }>;

  // Take the oldest available job for a run: queued and due, or running under
  // a lease that has expired.
  claimJob(runId: string, workerId: string, leaseMs: number): Promise<Job | null>;
  heartbeat(jobId: number, workerId: string, leaseMs: number): Promise<boolean>;
  finishJob(jobId: number, workerId: string, status: "done" | "cancelled"): Promise<void>;
  releaseJob(jobId: number, workerId: string, delayMs: number): Promise<void>;
  // Hand back jobs whose workers are known to be dead, without waiting for leases.
  reclaimJobs(runId: string, isDead: (workerId: string) => boolean): Promise<number>;
}

export class LostLeaseError extends Error {
  constructor(jobId: number) {
    super(`job ${jobId} is no longer held by this worker`);
  }
}

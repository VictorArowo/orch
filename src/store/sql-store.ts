import type { EventBody, RunEvent } from "../core/events.ts";
import { LostLeaseError, type Job, type LockedContext, type LockedWrite, type RunSummary, type Store } from "./store.ts";

// A minimal SQL surface that both node-postgres and PGlite can provide, so the
// same queries run against a real server and the embedded database.
export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlDb extends SqlClient {
  exec(text: string): Promise<void>;
  tx<T>(fn: (c: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  goal text NOT NULL,
  last_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  body jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS jobs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  locked_by text,
  locked_until timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  tries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_step
  ON jobs (run_id, step_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (run_id, status, run_after);
`;

interface EventRow {
  run_id: string;
  seq: number;
  body: EventBody;
  at: Date | string;
}

function toEvent(r: EventRow): RunEvent {
  const at = r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString();
  return { ...r.body, runId: r.run_id, seq: r.seq, at };
}

export class SqlStore implements Store {
  constructor(private readonly db: SqlDb) {}

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async createRun(runId: string, first: EventBody): Promise<RunEvent> {
    if (first.type !== "run.created") throw new Error("a run must start with run.created");
    return this.db.tx(async (c) => {
      await c.query(`INSERT INTO runs (id, goal, last_seq) VALUES ($1, $2, 1)`, [runId, first.goal]);
      const rows = await c.query<EventRow>(
        `INSERT INTO events (run_id, seq, type, body) VALUES ($1, 1, $2, $3::jsonb) RETURNING run_id, seq, body, at`,
        [runId, first.type, JSON.stringify(first)],
      );
      return toEvent(rows[0]!);
    });
  }

  async readEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    const rows = await this.db.query<EventRow>(
      `SELECT run_id, seq, body, at FROM events WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
      [runId, afterSeq],
    );
    return rows.map(toEvent);
  }

  async listRuns(): Promise<RunSummary[]> {
    const rows = await this.db.query<{ id: string; goal: string; created_at: Date | string; last_seq: number }>(
      `SELECT id, goal, created_at, last_seq FROM runs ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      runId: r.id,
      goal: r.goal,
      createdAt: new Date(r.created_at).toISOString(),
      lastSeq: r.last_seq,
    }));
  }

  async withRunLock<T>(
    runId: string,
    afterSeq: number,
    fn: (ctx: LockedContext) => Promise<{ write: LockedWrite; result: T }> | { write: LockedWrite; result: T },
    fence?: { jobId: number; workerId: string },
  ): Promise<{ appended: RunEvent[]; result: T }> {
    return this.db.tx(async (c) => {
      const locked = await c.query<{ last_seq: number }>(`SELECT last_seq FROM runs WHERE id = $1 FOR UPDATE`, [runId]);
      if (!locked[0]) throw new Error(`no run "${runId}"`);
      let seq = locked[0].last_seq;

      if (fence) {
        const held = await c.query(`SELECT 1 FROM jobs WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [
          fence.jobId,
          fence.workerId,
        ]);
        if (!held.length) throw new LostLeaseError(fence.jobId);
      }

      const newEvents = (
        await c.query<EventRow>(`SELECT run_id, seq, body, at FROM events WHERE run_id = $1 AND seq > $2 ORDER BY seq`, [
          runId,
          afterSeq,
        ])
      ).map(toEvent);
      const active = await c.query<{ step_id: string }>(
        `SELECT step_id FROM jobs WHERE run_id = $1 AND status IN ('queued', 'running')`,
        [runId],
      );

      const { write, result } = await fn({
        newEvents,
        activeJobs: active.length,
        activeStepIds: new Set(active.map((r) => r.step_id)),
      });

      const appended: RunEvent[] = [];
      for (const body of write.events) {
        seq++;
        const rows = await c.query<EventRow>(
          `INSERT INTO events (run_id, seq, type, body) VALUES ($1, $2, $3, $4::jsonb) RETURNING run_id, seq, body, at`,
          [runId, seq, body.type, JSON.stringify(body)],
        );
        appended.push(toEvent(rows[0]!));
      }
      if (appended.length) await c.query(`UPDATE runs SET last_seq = $2 WHERE id = $1`, [runId, seq]);
      if (write.cancelQueued) {
        await c.query(`UPDATE jobs SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'`, [runId]);
      }
      for (const stepId of write.enqueue ?? []) {
        await c.query(
          `INSERT INTO jobs (run_id, step_id) VALUES ($1, $2)
           ON CONFLICT (run_id, step_id) WHERE status IN ('queued', 'running') DO NOTHING`,
          [runId, stepId],
        );
      }
      return { appended, result };
    });
  }

  async claimJob(runId: string, workerId: string, leaseMs: number): Promise<Job | null> {
    const rows = await this.db.query<{ id: number; run_id: string; step_id: string; tries: number }>(
      `UPDATE jobs SET status = 'running', locked_by = $2,
              locked_until = now() + $3::float8 * interval '1 millisecond', tries = tries + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE run_id = $1 AND run_after <= now()
           AND (status = 'queued' OR (status = 'running' AND locked_until < now()))
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING id, run_id, step_id, tries`,
      [runId, workerId, leaseMs],
    );
    const r = rows[0];
    return r ? { id: r.id, runId: r.run_id, stepId: r.step_id, tries: r.tries } : null;
  }

  async heartbeat(jobId: number, workerId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE jobs SET locked_until = now() + $3::float8 * interval '1 millisecond'
       WHERE id = $1 AND locked_by = $2 AND status = 'running' RETURNING id`,
      [jobId, workerId, leaseMs],
    );
    return rows.length > 0;
  }

  async finishJob(jobId: number, workerId: string, status: "done" | "cancelled"): Promise<void> {
    await this.db.query(`UPDATE jobs SET status = $3, locked_until = NULL WHERE id = $1 AND locked_by = $2`, [
      jobId,
      workerId,
      status,
    ]);
  }

  async releaseJob(jobId: number, workerId: string, delayMs: number): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL,
              run_after = now() + $3::float8 * interval '1 millisecond'
       WHERE id = $1 AND locked_by = $2`,
      [jobId, workerId, delayMs],
    );
  }

  async reclaimJobs(runId: string, isDead: (workerId: string) => boolean): Promise<number> {
    const running = await this.db.query<{ id: number; locked_by: string | null }>(
      `SELECT id, locked_by FROM jobs WHERE run_id = $1 AND status = 'running'`,
      [runId],
    );
    let n = 0;
    for (const r of running) {
      if (r.locked_by && !isDead(r.locked_by)) continue;
      await this.db.query(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, run_after = now()
         WHERE id = $1 AND status = 'running'`,
        [r.id],
      );
      n++;
    }
    return n;
  }
}

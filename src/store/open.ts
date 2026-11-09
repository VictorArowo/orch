import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SqlStore, type SqlClient, type SqlDb } from "./sql-store.js";
import type { Store } from "./store.js";

function pgliteDb(db: PGlite): SqlDb {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await db.query<T>(text, params as unknown[])).rows;
    },
    async exec(text: string) {
      await db.exec(text);
    },
    async tx<T>(fn: (c: SqlClient) => Promise<T>) {
      return db.transaction((tx) =>
        fn({
          async query<R>(text: string, params?: unknown[]) {
            return (await tx.query<R>(text, params as unknown[])).rows;
          },
        }),
      );
    },
    close: () => db.close(),
  };
}

function pgDb(pool: pg.Pool): SqlDb {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rows as T[];
    },
    async exec(text: string) {
      await pool.query(text);
    },
    async tx<T>(fn: (c: SqlClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(text: string, params?: unknown[]) {
            return (await client.query(text, params)).rows as R[];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// `postgres://...` connects to a server. Anything else is a directory for an
// embedded PGlite database, and "memory:" keeps it in memory (for tests).
export async function openStore(target: string): Promise<Store> {
  let db: SqlDb;
  if (/^postgres(ql)?:\/\//.test(target)) {
    const pool = new pg.Pool({ connectionString: target, max: 10 });
    db = pgDb(pool);
  } else if (target === "memory:") {
    db = pgliteDb(await PGlite.create());
  } else {
    mkdirSync(target, { recursive: true });
    db = pgliteDb(await PGlite.create(target));
  }
  const store = new SqlStore(db);
  await store.init();
  return store;
}

// For display: never print credentials embedded in a connection string.
export function describeTarget(target: string): string {
  return target.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
}

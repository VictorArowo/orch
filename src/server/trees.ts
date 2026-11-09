import { randomBytes } from "node:crypto";
import type { SqlDb } from "../store/sql-store.ts";

// Trees a user has saved from the editor, kept in the file format.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_trees (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_trees_by_user ON saved_trees (user_id, updated_at);
`;

export interface SavedTree {
  id: string;
  goal: string;
  updatedAt: string;
}

export class SavedTrees {
  constructor(private readonly db: SqlDb) {}

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async list(userId: string): Promise<SavedTree[]> {
    const rows = await this.db.query<{ id: string; goal: string; updated_at: Date }>(
      `SELECT id, goal, updated_at FROM saved_trees WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, goal: r.goal, updatedAt: new Date(r.updated_at).toISOString() }));
  }

  async get(userId: string, id: string): Promise<{ id: string; tree: unknown } | undefined> {
    const rows = await this.db.query<{ id: string; body: unknown }>(`SELECT id, body FROM saved_trees WHERE user_id = $1 AND id = $2`, [userId, id]);
    return rows[0] ? { id: rows[0].id, tree: rows[0].body } : undefined;
  }

  // Save a new tree, or overwrite one of the user's own by id.
  async save(userId: string, tree: unknown, goal: string, id?: string): Promise<SavedTree> {
    if (id) {
      const rows = await this.db.query<{ id: string; updated_at: Date }>(
        `UPDATE saved_trees SET body = $3::jsonb, goal = $4, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id, updated_at`,
        [userId, id, JSON.stringify(tree), goal],
      );
      if (rows[0]) return { id: rows[0].id, goal, updatedAt: new Date(rows[0].updated_at).toISOString() };
    }
    const newId = `t_${randomBytes(6).toString("base64url")}`;
    const rows = await this.db.query<{ updated_at: Date }>(
      `INSERT INTO saved_trees (id, user_id, goal, body) VALUES ($1, $2, $3, $4::jsonb) RETURNING updated_at`,
      [newId, userId, goal, JSON.stringify(tree)],
    );
    return { id: newId, goal, updatedAt: new Date(rows[0]!.updated_at).toISOString() };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return (await this.db.query(`DELETE FROM saved_trees WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id])).length > 0;
  }
}

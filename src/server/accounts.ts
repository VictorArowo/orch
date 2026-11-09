import { randomBytes } from "node:crypto";
import type { SqlDb } from "../store/sql-store.ts";
import { hashToken, newToken, seal, unseal, type MasterKeys, type Sealed } from "./crypto.ts";

// Accounts, sessions and stored API keys, in the same database as runs.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source text NOT NULL,
  last4 text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  wrapped_key text NOT NULL,
  wrap_iv text NOT NULL,
  wrap_tag text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (user_id, provider)
);
`;

export interface UserSettings {
  defaultPanel?: string;
  defaultCapUsd?: number;
  planCapUsd?: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  settings: UserSettings;
  createdAt: string;
}

// What the browser may see about a stored key: never the key itself.
export interface KeyInfo {
  provider: string;
  source: "oauth" | "pasted";
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export class EmailTakenError extends Error {
  constructor() {
    super("an account with that email already exists");
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  settings: UserSettings;
  created_at: Date | string;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name, settings: r.settings ?? {}, createdAt: iso(r.created_at)! };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const SESSION_DAYS = 30;

export class AccountStore {
  constructor(
    private readonly db: SqlDb,
    private readonly master: MasterKeys,
  ) {}

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  // ---- Users ----

  async createUser(email: string, name: string, passwordHash: string): Promise<User> {
    const id = `u_${randomBytes(9).toString("base64url")}`;
    try {
      const rows = await this.db.query<UserRow>(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, normaliseEmail(email), name.trim(), passwordHash],
      );
      return toUser(rows[0]!);
    } catch (err) {
      if (/unique|duplicate/i.test(String((err as Error).message))) throw new EmailTakenError();
      throw err;
    }
  }

  async findByEmail(email: string): Promise<(User & { passwordHash: string }) | undefined> {
    const rows = await this.db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [normaliseEmail(email)]);
    const r = rows[0];
    return r ? { ...toUser(r), passwordHash: r.password_hash } : undefined;
  }

  async getUser(id: string): Promise<User | undefined> {
    const rows = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async passwordHash(id: string): Promise<string | undefined> {
    const rows = await this.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [id]);
    return rows[0]?.password_hash;
  }

  async updateProfile(id: string, profile: { name?: string; email?: string }): Promise<User> {
    try {
      const rows = await this.db.query<UserRow>(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email) WHERE id = $1 RETURNING *`,
        [id, profile.name?.trim() ?? null, profile.email ? normaliseEmail(profile.email) : null],
      );
      return toUser(rows[0]!);
    } catch (err) {
      if (/unique|duplicate/i.test(String((err as Error).message))) throw new EmailTakenError();
      throw err;
    }
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  }

  async updateSettings(id: string, settings: UserSettings): Promise<User> {
    const rows = await this.db.query<UserRow>(`UPDATE users SET settings = settings || $2::jsonb WHERE id = $1 RETURNING *`, [
      id,
      JSON.stringify(settings),
    ]);
    return toUser(rows[0]!);
  }

  // Deleting an account deletes its runs, sessions and stored key ciphertext.
  async deleteUser(id: string): Promise<void> {
    await this.db.tx(async (c) => {
      await c.query(`DELETE FROM runs WHERE user_id = $1`, [id]);
      await c.query(`DELETE FROM users WHERE id = $1`, [id]);
    });
  }

  // ---- Sessions ----

  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [hashToken(token), userId, expiresAt]);
    return { token, expiresAt };
  }

  async userForSession(token: string): Promise<User | undefined> {
    const rows = await this.db.query<UserRow>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  }

  // Sign out everywhere else, for example after a password change.
  async deleteOtherSessions(userId: string, keepToken: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, hashToken(keepToken)]);
  }

  // ---- Keys ----

  async putKey(userId: string, provider: string, key: string, source: "oauth" | "pasted"): Promise<KeyInfo> {
    const id = `k_${randomBytes(9).toString("base64url")}`;
    const sealed = seal(this.master, key, `${userId}:${provider}`);
    const rows = await this.db.query<{ created_at: Date }>(
      `INSERT INTO api_keys (id, user_id, provider, source, last4, ciphertext, iv, tag, wrapped_key, wrap_iv, wrap_tag, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         id = EXCLUDED.id, source = EXCLUDED.source, last4 = EXCLUDED.last4, ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv, tag = EXCLUDED.tag, wrapped_key = EXCLUDED.wrapped_key, wrap_iv = EXCLUDED.wrap_iv,
         wrap_tag = EXCLUDED.wrap_tag, key_version = EXCLUDED.key_version, created_at = now(), last_used_at = NULL
       RETURNING created_at`,
      [id, userId, provider, source, key.slice(-4), sealed.ciphertext, sealed.iv, sealed.tag, sealed.wrappedKey, sealed.wrapIv, sealed.wrapTag, sealed.keyVersion],
    );
    return { provider, source, last4: key.slice(-4), createdAt: iso(rows[0]!.created_at)!, lastUsedAt: null };
  }

  async keys(userId: string): Promise<KeyInfo[]> {
    const rows = await this.db.query<{ provider: string; source: "oauth" | "pasted"; last4: string; created_at: Date; last_used_at: Date | null }>(
      `SELECT provider, source, last4, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY provider`,
      [userId],
    );
    return rows.map((r) => ({ provider: r.provider, source: r.source, last4: r.last4, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at) }));
  }

  // Decrypt a key for one call. Callers drop it as soon as the call is made.
  async useKey(userId: string, provider: string): Promise<string | undefined> {
    const rows = await this.db.query<{
      ciphertext: string;
      iv: string;
      tag: string;
      wrapped_key: string;
      wrap_iv: string;
      wrap_tag: string;
      key_version: number;
    }>(`SELECT ciphertext, iv, tag, wrapped_key, wrap_iv, wrap_tag, key_version FROM api_keys WHERE user_id = $1 AND provider = $2`, [userId, provider]);
    const r = rows[0];
    if (!r) return undefined;
    const sealed: Sealed = {
      ciphertext: r.ciphertext,
      iv: r.iv,
      tag: r.tag,
      wrappedKey: r.wrapped_key,
      wrapIv: r.wrap_iv,
      wrapTag: r.wrap_tag,
      keyVersion: r.key_version,
    };
    const key = unseal(this.master, sealed, `${userId}:${provider}`);
    void this.db.query(`UPDATE api_keys SET last_used_at = now() WHERE user_id = $1 AND provider = $2`, [userId, provider]).catch(() => {});
    return key;
  }

  async deleteKey(userId: string, provider: string): Promise<boolean> {
    const rows = await this.db.query(`DELETE FROM api_keys WHERE user_id = $1 AND provider = $2 RETURNING id`, [userId, provider]);
    return rows.length > 0;
  }
}

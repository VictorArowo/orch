import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Passwords, session tokens and stored API keys. Only Node's own primitives
// are used: scrypt for passwords, SHA-256 for session tokens (which are long
// and random, so a fast hash is enough), AES-256-GCM for keys.

// ---- Passwords ----

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { ...opts, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A hash to compare against when the email isn't known, so a failed sign-in
// takes as long whether or not the account exists.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}

// ---- Session tokens ----

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

// ---- Stored keys: envelope encryption ----
//
// Each key is encrypted with its own random data key, and the data key is
// encrypted with a master key that never touches the database. A leaked
// database on its own exposes nothing usable. Each record names the master
// key version, so the master key can be rotated.

export interface MasterKeys {
  current: number;
  keys: Map<number, Buffer>;
}

export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedKey: string;
  wrapIv: string;
  wrapTag: string;
  keyVersion: number;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer, aad?: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// `context` (the owner and record id) is bound into the ciphertext, so a
// sealed key copied onto another account's record won't decrypt.
export function seal(master: MasterKeys, plaintext: string, context: string): Sealed {
  const mk = master.keys.get(master.current);
  if (!mk) throw new Error("no current master key");
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = gcmEncrypt(mk, dataKey);
  dataKey.fill(0);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    wrappedKey: wrapped.ciphertext.toString("base64"),
    wrapIv: wrapped.iv.toString("base64"),
    wrapTag: wrapped.tag.toString("base64"),
    keyVersion: master.current,
  };
}

export function unseal(master: MasterKeys, sealed: Sealed, context: string): string {
  const mk = master.keys.get(sealed.keyVersion);
  if (!mk) throw new Error(`master key version ${sealed.keyVersion} isn't configured`);
  const b = (s: string) => Buffer.from(s, "base64");
  const dataKey = gcmDecrypt(mk, b(sealed.wrappedKey), b(sealed.wrapIv), b(sealed.wrapTag));
  try {
    return gcmDecrypt(dataKey, b(sealed.ciphertext), b(sealed.iv), b(sealed.tag), Buffer.from(context)).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

// Master keys come from ORCH_MASTER_KEYS ("2:base64,1:base64", newest first)
// or ORCH_MASTER_KEY (version 1). Locally, when neither is set, a key is
// generated once into a file outside the database.
export function loadMasterKeys(env: NodeJS.ProcessEnv, fallbackFile?: string): MasterKeys {
  const parse = (b64: string) => {
    const key = Buffer.from(b64.trim(), "base64");
    if (key.length !== 32) throw new Error("a master key must be 32 bytes, base64-encoded (try: openssl rand -base64 32)");
    return key;
  };
  if (env.ORCH_MASTER_KEYS) {
    const keys = new Map<number, Buffer>();
    let current = 0;
    for (const part of env.ORCH_MASTER_KEYS.split(",")) {
      const [v, b64] = part.split(":");
      const version = Number(v);
      if (!Number.isInteger(version) || version < 1 || !b64) throw new Error('ORCH_MASTER_KEYS entries look like "2:base64key"');
      keys.set(version, parse(b64));
      current = Math.max(current, version);
    }
    return { current, keys };
  }
  if (env.ORCH_MASTER_KEY) return { current: 1, keys: new Map([[1, parse(env.ORCH_MASTER_KEY)]]) };
  if (!fallbackFile) throw new Error("set ORCH_MASTER_KEY to store keys");
  if (!existsSync(fallbackFile)) {
    mkdirSync(dirname(fallbackFile), { recursive: true });
    writeFileSync(fallbackFile, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
    chmodSync(fallbackFile, 0o600);
  }
  return { current: 1, keys: new Map([[1, parse(readFileSync(fallbackFile, "utf8"))]]) };
}

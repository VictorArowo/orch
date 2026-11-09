import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, hashToken, loadMasterKeys, seal, unseal, verifyPassword, type MasterKeys } from "../src/server/crypto.ts";

const keys = (...versions: number[]): MasterKeys => ({ current: Math.max(...versions), keys: new Map(versions.map((v) => [v, randomBytes(32)])) });

describe("passwords and tokens", () => {
  it("hashes passwords with a salt and verifies them", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  it("stores session tokens only as hashes", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toContain("abc");
  });
});

describe("sealed keys", () => {
  it("round-trips, and the ciphertext reveals nothing", () => {
    const master = keys(1);
    const secret = `sk-or-v1-${"x".repeat(40)}`;
    const sealed = seal(master, secret, "u_1:openrouter");
    expect(JSON.stringify(sealed)).not.toContain(secret.slice(10));
    expect(unseal(master, sealed, "u_1:openrouter")).toBe(secret);
    // Each seal uses a fresh data key and IV.
    expect(seal(master, secret, "u_1:openrouter").ciphertext).not.toBe(sealed.ciphertext);
  });

  it("won't open under another account, another master key or after tampering", () => {
    const master = keys(1);
    const sealed = seal(master, "secret", "u_1:openrouter");
    expect(() => unseal(master, sealed, "u_2:openrouter")).toThrow();
    expect(() => unseal(keys(1), sealed, "u_1:openrouter")).toThrow();
    const flipped = { ...sealed, ciphertext: Buffer.from(Buffer.from(sealed.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
    expect(() => unseal(master, flipped, "u_1:openrouter")).toThrow();
  });

  it("keeps opening old keys after the master key is rotated", () => {
    const v1 = keys(1);
    const sealed = seal(v1, "secret", "ctx");
    const rotated: MasterKeys = { current: 2, keys: new Map([[2, randomBytes(32)], [1, v1.keys.get(1)!]]) };
    expect(unseal(rotated, sealed, "ctx")).toBe("secret");
    expect(seal(rotated, "secret", "ctx").keyVersion).toBe(2);
  });

  it("reads master keys from the environment, or makes a private local one", () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    expect(loadMasterKeys({ ORCH_MASTER_KEY: k1 }).current).toBe(1);
    const multi = loadMasterKeys({ ORCH_MASTER_KEYS: `2:${k2},1:${k1}` });
    expect([multi.current, [...multi.keys.keys()].sort()]).toEqual([2, [1, 2]]);
    expect(() => loadMasterKeys({ ORCH_MASTER_KEY: "too-short" })).toThrow(/32 bytes/);

    const file = join(mkdtempSync(join(tmpdir(), "orch-mk-")), "nested", "master.key");
    const made = loadMasterKeys({}, file);
    expect(made.keys.get(1)!.length).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMasterKeys({}, file).keys.get(1)!.equals(made.keys.get(1)!)).toBe(true);
    expect(readFileSync(file, "utf8").trim().length).toBeGreaterThan(40);
  });
});

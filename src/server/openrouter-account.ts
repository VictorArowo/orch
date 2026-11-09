import { createHash, randomBytes } from "node:crypto";
import { redact } from "../gateway/redact.ts";

// Talking to OpenRouter about a user's key, as opposed to with it: checking
// it works and what it can still spend, and getting one through OpenRouter's
// OAuth (PKCE) flow so the user never has to copy it around.

const BASE = "https://openrouter.ai";

export type Fetch = typeof fetch;

export class KeyRejectedError extends Error {}

export interface KeyStatus {
  label?: string;
  limitUsd: number | null;
  usageUsd: number;
  remainingUsd: number | null;
}

// A free call: OpenRouter reports the key's label, limit and usage.
export async function checkKey(key: string, fetchFn: Fetch = fetch): Promise<KeyStatus> {
  let res: Response;
  try {
    res = await fetchFn(`${BASE}/api/v1/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(redact(`couldn't reach OpenRouter: ${(err as Error).message}`, [key]));
  }
  if (res.status === 401 || res.status === 403) throw new KeyRejectedError("OpenRouter didn't accept that key");
  if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status} when checking the key`);
  const body = (await res.json()) as { data?: { label?: string; limit?: number | null; usage?: number; limit_remaining?: number | null } };
  const d = body.data ?? {};
  const status: KeyStatus = {
    limitUsd: typeof d.limit === "number" ? d.limit : null,
    usageUsd: typeof d.usage === "number" ? d.usage : 0,
    remainingUsd: typeof d.limit_remaining === "number" ? d.limit_remaining : null,
  };
  if (d.label) status.label = d.label;
  return status;
}

export function looksLikeOpenRouterKey(key: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{16,}$/.test(key.trim());
}

// ---- OAuth with PKCE ----

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(callbackUrl: string, challenge: string): string {
  const u = new URL(`${BASE}/auth`);
  u.searchParams.set("callback_url", callbackUrl);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(code: string, verifier: string, fetchFn: Fetch = fetch): Promise<string> {
  const res = await fetchFn(`${BASE}/api/v1/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new KeyRejectedError(`OpenRouter didn't complete the connection (HTTP ${res.status}). Try connecting again.`);
  const body = (await res.json()) as { key?: string };
  if (!body.key) throw new KeyRejectedError("OpenRouter's reply had no key in it");
  return body.key;
}

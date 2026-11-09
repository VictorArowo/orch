import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/core/events.ts";
import { apply, emptyState } from "../src/core/state.ts";
import type { Gateway } from "../src/gateway/gateway.ts";
import { MockGateway } from "../src/gateway/mock.ts";
import type { MasterKeys } from "../src/server/crypto.ts";
import { serve, type ServeOptions } from "../src/server/server.ts";
import { openStore } from "../src/store/open.ts";
import type { SqlStore } from "../src/store/sql-store.ts";

const GOOD_KEY = `sk-or-v1-${"a".repeat(40)}1234`;
const master: MasterKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };

let store: SqlStore;
let server: Awaited<ReturnType<typeof serve>>;

// A pretend OpenRouter for the account endpoints: it accepts GOOD_KEY and
// trades an OAuth code for a key when the PKCE verifier matches.
let lastChallenge = "";
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/v1/key")) {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${GOOD_KEY}`) return new Response("{}", { status: 401 });
    return Response.json({ data: { label: "orch test", limit: 5, usage: 1.25, limit_remaining: 3.75 } });
  }
  if (url.endsWith("/api/v1/auth/keys")) {
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
    const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
    if (body.code !== "the-code" || challenge !== lastChallenge) return new Response("{}", { status: 403 });
    return Response.json({ key: GOOD_KEY });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// Stands in for OpenRouter, so no test reaches the network or spends money.
const standIn = (): Gateway => {
  const mock = new MockGateway({ latency: 5, checkReviseRate: 0, critiqueObjects: false });
  return { name: "openrouter", price: (m) => mock.price(m), complete: (req, signal) => mock.complete(req, signal) };
};

async function start(extra: Partial<ServeOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "orch-serve-"));
  cpSync("panels", join(root, "panels"), { recursive: true });
  cpSync("examples", join(root, "examples"), { recursive: true });
  store = await openStore("memory:");
  server = await serve({
    store,
    openRouter: standIn,
    master,
    root,
    port: 0,
    fetch: fakeFetch,
    ...extra,
  });
}

afterEach(async () => {
  await server?.close();
  await store?.close();
});

// A browser: one cookie jar, JSON requests.
function client() {
  let cookie = "";
  const call = async <T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const init: RequestInit = { headers: { cookie } };
    if (body !== undefined) {
      init.method = "POST";
      init.body = JSON.stringify(body);
      init.headers = { cookie, "content-type": "application/json" };
    }
    const res = await fetch(`${server.url}${path}`, init);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, value] = pair!.split("=");
      const jar = Object.fromEntries(cookie.split("; ").filter(Boolean).map((p) => p.split("=") as [string, string]));
      if (value) jar[name!] = value;
      else delete jar[name!];
      cookie = Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
    return { status: res.status, json: (await res.json()) as T };
  };
  return { call, cookie: () => cookie };
}

// A new account. Like a real user, it adds an OpenRouter key before running anything.
async function signedUp(email = `u${randomBytes(4).toString("hex")}@example.com`, opts: { key?: boolean } = {}) {
  const c = client();
  const r = await c.call("/api/auth/signup", { email, name: "Ada", password: "correct horse battery" });
  expect(r.status).toBe(200);
  if (opts.key !== false) expect((await c.call("/api/keys/openrouter", { key: GOOD_KEY })).status).toBe(200);
  return c;
}

// Read a run's event stream until `until` says stop.
async function stream(c: ReturnType<typeof client>, runId: string, until: (e: RunEvent) => boolean, after = 0): Promise<RunEvent[]> {
  const ctrl = new AbortController();
  const res = await fetch(`${server.url}/api/runs/${runId}/events?after=${after}`, { signal: ctrl.signal, headers: { cookie: c.cookie() } });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6)) as RunEvent;
      events.push(e);
      if (until(e)) {
        ctrl.abort();
        return events;
      }
    }
  }
  return events;
}

describe("accounts", () => {
  it("signs up, signs out and signs back in", async () => {
    await start();
    const c = await signedUp("ada@example.com");
    const me = await c.call<{ user: { email: string; name: string } }>("/api/me");
    expect(me.json.user).toMatchObject({ email: "ada@example.com", name: "Ada" });
    expect(c.cookie()).toMatch(/orch_session=/);

    await c.call("/api/auth/signout", {});
    expect((await c.call("/api/me")).status).toBe(401);

    expect((await c.call("/api/auth/signin", { email: "ADA@example.com ", password: "wrong password!" })).status).toBe(401);
    expect((await c.call("/api/auth/signin", { email: "ada@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await c.call("/api/me")).status).toBe(200);
  });

  it("refuses weak passwords, bad emails and duplicate accounts", async () => {
    await start();
    const c = client();
    expect((await c.call("/api/auth/signup", { email: "x@example.com", password: "short" })).json).toMatchObject({ error: expect.stringMatching(/10 characters/) });
    expect((await c.call("/api/auth/signup", { email: "nope", password: "long enough password" })).status).toBe(400);
    await signedUp("taken@example.com");
    expect((await client().call("/api/auth/signup", { email: "Taken@example.com", password: "long enough password" })).status).toBe(409);
  });

  it("needs a session for everything but signing in", async () => {
    await start();
    const c = client();
    expect((await c.call("/api/config")).status).toBe(200);
    for (const path of ["/api/me", "/api/panels", "/api/runs", "/api/keys", "/api/trees"]) expect((await c.call(path)).status).toBe(401);
  });

  it("only accepts JSON for changes", async () => {
    await start();
    const res = await fetch(`${server.url}/api/auth/signin`, { method: "POST", body: "email=a&password=b", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(415);
  });

  it("slows down password guessing", async () => {
    await start();
    await signedUp("guess@example.com");
    const c = client();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.call("/api/auth/signin", { email: "guess@example.com", password: `wrong ${i} xxxxxx` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("changes the password and signs other devices out", async () => {
    await start();
    const laptop = await signedUp("pw@example.com");
    const phone = client();
    await phone.call("/api/auth/signin", { email: "pw@example.com", password: "correct horse battery" });
    expect((await laptop.call("/api/me/password", { current: "nope", next: "a brand new password" })).status).toBe(403);
    expect((await laptop.call("/api/me/password", { current: "correct horse battery", next: "a brand new password" })).status).toBe(200);
    expect((await laptop.call("/api/me")).status).toBe(200);
    expect((await phone.call("/api/me")).status).toBe(401);
    expect((await client().call("/api/auth/signin", { email: "pw@example.com", password: "a brand new password" })).status).toBe(200);
  });

  it("updates profile and defaults", async () => {
    await start();
    const c = await signedUp();
    const p = await c.call<{ user: { name: string; email: string } }>("/api/me/profile", { name: "Grace", email: "grace@example.com" });
    expect(p.json.user).toMatchObject({ name: "Grace", email: "grace@example.com" });
    const s = await c.call<{ user: { settings: Record<string, unknown> } }>("/api/me/settings", { defaultPanel: "starter", defaultCapUsd: 0.75, planCapUsd: 5 });
    expect(s.json.user.settings).toEqual({ defaultPanel: "starter", defaultCapUsd: 0.75, planCapUsd: 1 });
    expect((await c.call("/api/me/settings", { defaultPanel: "nope" })).status).toBe(404);
  });
});

describe("runs belong to their account", () => {
  it("runs a tree and streams its events, replaying from any point", async () => {
    await start();
    const c = await signedUp();
    const tree = (await c.call<{ tree: unknown }>("/api/tree?path=examples/vector-dbs.tree.json")).json.tree;
    const created = await c.call<{ runId: string }>("/api/runs", { tree, panel: "starter", capUsd: 0.5 });
    expect(created.status).toBe(200);
    const { runId } = created.json;

    const events = await stream(c, runId, (e) => e.type === "run.done");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const state = emptyState(runId);
    for (const e of events) apply(state, e);
    expect(state.status).toBe("done");
    expect(state.owner).toBeTruthy();

    const tail = await stream(c, runId, (e) => e.type === "run.done", events.length - 3);
    expect(tail.map((e) => e.seq)).toEqual([events.length - 2, events.length - 1, events.length]);
    expect((await c.call<{ runId: string; status: string }[]>("/api/runs")).json.map((r) => r.status)).toEqual(["done"]);
  });

  it("hides one account's runs and trees from another", async () => {
    await start();
    const a = await signedUp();
    const b = await signedUp();
    const { runId } = (await a.call<{ runId: string }>("/api/runs", { tree: { goal: "g", root: {} }, panel: "starter", capUsd: 0.5 })).json;
    const saved = (await a.call<{ id: string }>("/api/trees", { tree: { goal: "mine", root: {} } })).json;
    expect((await b.call<unknown[]>("/api/runs")).json).toEqual([]);
    expect((await b.call(`/api/runs/${runId}/pause`, {})).status).toBe(404);
    expect((await b.call(`/api/runs/${runId}/resume`, {})).status).toBe(404);
    const res = await fetch(`${server.url}/api/runs/${runId}/events`, { headers: { cookie: b.cookie() } });
    expect(res.status).toBe(404);
    expect((await b.call(`/api/trees/${saved.id}`)).status).toBe(404);
    expect((await b.call<unknown[]>("/api/trees")).json).toEqual([]);
    expect((await a.call<{ id: string }[]>("/api/trees")).json.map((t) => t.id)).toEqual([saved.id]);
  });

  it("pauses and resumes a run", async () => {
    await start();
    const c = await signedUp();
    const tree = { goal: "g", root: { items: ["a", "b", "c", "d", "e", "f"], template: { role: "researcher" } } };
    const { runId } = (await c.call<{ runId: string }>("/api/runs", { tree, panel: "starter", capUsd: 0.5, concurrency: 1 })).json;
    await c.call(`/api/runs/${runId}/pause`, {});
    const paused = await stream(c, runId, (e) => e.type === "run.paused");
    expect(paused.at(-1)).toMatchObject({ type: "run.paused", reason: "paused from the browser" });
    await c.call(`/api/runs/${runId}/resume`, { capUsd: 1 });
    const rest = await stream(c, runId, (e) => e.type === "run.done", paused.at(-1)!.seq);
    // The call in flight at the pause still finishes before the resume.
    expect(rest.find((e) => e.type === "run.resumed")).toMatchObject({ cap: 1_000_000_000 });
    expect(rest.at(-1)!.type).toBe("run.done");
  });

  it("drafts and checks trees, and refuses files outside the examples", async () => {
    await start();
    const c = await signedUp();
    const r = await c.call<{ tree: { root: { mode: string } }; drafted: { costNanos: number } }>("/api/plan", { goal: "Compare three note-taking apps.", panel: "starter" });
    expect(r.json.tree.root.mode).toBe("sequence");
    expect(r.json.drafted.costNanos).toBeGreaterThan(0);
    const bad = await c.call<{ ok: boolean; error: string }>("/api/check", { panel: "starter", tree: { goal: "g", root: { role: "critic" } } });
    expect(bad.json).toMatchObject({ ok: false, error: expect.stringMatching(/its job is critique/) });
    expect((await c.call("/api/tree?path=../package.json")).status).toBe(400);
    expect((await c.call("/api/runs", { tree: { goal: "g", root: {} }, panel: "../x", capUsd: 1 })).status).toBe(400);
  });

  it("deletes an account with its runs, trees and keys", async () => {
    await start();
    const c = await signedUp("gone@example.com");
    const { runId } = (await c.call<{ runId: string }>("/api/runs", { tree: { goal: "g", root: {} }, panel: "starter", capUsd: 0.5 })).json;
    expect((await c.call("/api/me/delete", { password: "wrong" })).status).toBe(403);
    expect((await c.call("/api/me/delete", { password: "correct horse battery" })).status).toBe(200);
    expect((await c.call("/api/me")).status).toBe(401);
    expect(await store.ownerOf(runId)).toBeUndefined();
    const keys = await store.sql.query("SELECT * FROM api_keys");
    expect(keys).toEqual([]);
    expect((await client().call("/api/auth/signin", { email: "gone@example.com", password: "correct horse battery" })).status).toBe(401);
  });
});

describe("keys", () => {
  // On OpenRouter mode, each call decrypts its owner's key; this records them.
  const used: string[] = [];
  const recording = (key: () => Promise<string>): Gateway => {
    const mock = new MockGateway({ checkReviseRate: 0, critiqueObjects: false });
    return {
      name: "openrouter",
      price: (m) => mock.price(m),
      complete: async (req, signal) => {
        used.push(await key());
        return mock.complete(req, signal);
      },
    };
  };

  it("checks a pasted key, stores it encrypted, and never shows it again", async () => {
    await start({ openRouter: recording });
    const c = await signedUp(undefined, { key: false });
    expect((await c.call("/api/keys/openrouter", { key: "not-a-key" })).status).toBe(400);
    expect((await c.call("/api/keys/openrouter", { key: `sk-or-v1-${"b".repeat(40)}` })).json).toMatchObject({ error: "OpenRouter didn't accept that key" });

    const saved = await c.call<{ key: { last4: string; source: string }; status: { remainingUsd: number } }>("/api/keys/openrouter", { key: GOOD_KEY });
    expect(saved.json.key).toMatchObject({ last4: "1234", source: "pasted" });
    expect(saved.json.status.remainingUsd).toBe(3.75);

    const me = await c.call("/api/me");
    expect(JSON.stringify(me.json)).not.toContain(GOOD_KEY);
    const rows = await store.sql.query<Record<string, unknown>>("SELECT * FROM api_keys");
    expect(JSON.stringify(rows)).not.toContain(GOOD_KEY);
    expect(JSON.stringify(rows)).not.toContain(GOOD_KEY.slice(0, 20));

    expect((await c.call<{ ok: boolean; status: { label: string } }>("/api/keys/openrouter/check", {})).json).toMatchObject({ ok: true, status: { label: "orch test" } });
  });

  it("runs on the owner's own key, and needs one first", async () => {
    used.length = 0;
    await start({ openRouter: recording });
    const c = await signedUp(undefined, { key: false });
    const tree = { goal: "g", root: { role: "researcher" } };
    expect((await c.call("/api/runs", { tree, panel: "starter", capUsd: 0.5 })).status).toBe(412);
    expect((await c.call("/api/plan", { goal: "anything", panel: "starter" })).status).toBe(412);

    await c.call("/api/keys/openrouter", { key: GOOD_KEY });
    const { runId } = (await c.call<{ runId: string }>("/api/runs", { tree, panel: "starter", capUsd: 0.5 })).json;
    const events = await stream(c, runId, (e) => e.type === "run.done" || e.type === "run.stopped");
    expect(events.at(-1)!.type).toBe("run.done");
    expect(used).toEqual([GOOD_KEY]);
    // The key never reaches the event log.
    expect(JSON.stringify(events)).not.toContain(GOOD_KEY);
    expect((await c.call<{ lastUsedAt: string | null }[]>("/api/keys")).json[0]!.lastUsedAt).not.toBeNull();

    expect((await c.call("/api/keys/openrouter/delete", {})).json).toEqual({ deleted: true });
    expect((await c.call("/api/runs", { tree, panel: "starter", capUsd: 0.5 })).status).toBe(412);
  });

  it("connects through OpenRouter's OAuth flow", async () => {
    await start({ openRouter: recording });
    const c = await signedUp(undefined, { key: false });
    const { url } = (await c.call<{ url: string }>("/api/keys/openrouter/connect", { callbackUrl: "http://localhost:3000/settings/connected" })).json;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("callback_url")).toBe("http://localhost:3000/settings/connected");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    lastChallenge = u.searchParams.get("code_challenge")!;
    expect(c.cookie()).toMatch(/orch_pkce=/);

    expect((await c.call("/api/keys/openrouter/finish", { code: "wrong-code" })).status).toBe(400);
    // The verifier is single-use, so a second try has to start again.
    expect((await c.call("/api/keys/openrouter/finish", { code: "the-code" })).json).toMatchObject({ error: expect.stringMatching(/start it again/) });

    const again = (await c.call<{ url: string }>("/api/keys/openrouter/connect", { callbackUrl: "http://localhost:3000/settings/connected" })).json;
    lastChallenge = new URL(again.url).searchParams.get("code_challenge")!;
    const done = await c.call<{ key: { source: string; last4: string } }>("/api/keys/openrouter/finish", { code: "the-code" });
    expect(done.json.key).toMatchObject({ source: "oauth", last4: "1234" });
  });
});

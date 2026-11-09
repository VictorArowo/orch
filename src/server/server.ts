import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { checkTree, treeToJson } from "../core/check-tree.ts";
import { estimateTree } from "../core/estimate.ts";
import type { Drafted, RunEvent } from "../core/events.ts";
import { usdToNanos } from "../core/money.ts";
import { PanelError, parsePanel, type Panel } from "../core/panel.ts";
import { DEFAULT_LIMITS, parseTree, TreeError, type Limits } from "../core/tree.ts";
import { Engine } from "../engine/engine.ts";
import { GatewayError, type Gateway } from "../gateway/gateway.ts";
import { OpenRouterGateway } from "../gateway/openrouter.ts";
import { redact } from "../gateway/redact.ts";
import { plan, PlanError } from "../planner/planner.ts";
import type { SqlStore } from "../store/sql-store.ts";
import { AccountStore, EmailTakenError, SESSION_DAYS, type User } from "./accounts.ts";
import { dummyHash, hashPassword, verifyPassword, type MasterKeys } from "./crypto.ts";
import { authorizeUrl, checkKey, exchangeCode, KeyRejectedError, looksLikeOpenRouterKey, newPkce, type Fetch } from "./openrouter-account.ts";
import { RateLimiter } from "./rate-limit.ts";
import { SavedTrees } from "./trees.ts";

// The engine as an HTTP service for the web app: accounts and sessions,
// stored keys, drafting and checking trees, and runs that each user starts
// and follows as a stream of events. Every route but sign-up, sign-in and
// config needs a session, and everything is scoped to its owner.

export interface ServeOptions {
  store: SqlStore;
  // Mock models for everyone, or OpenRouter on each account's own key.
  mode: "mock" | "openrouter";
  mockGateway?: Gateway;
  // How to reach OpenRouter with a key that is decrypted only at call time.
  // Tests swap this out.
  openRouter?: (key: () => Promise<string>) => Gateway;
  master: MasterKeys;
  // The repo directory: panels/ and examples/ are read from here.
  root: string;
  port: number;
  host?: string;
  planCapUsd?: number;
  // Mark cookies Secure (serve over HTTPS in production).
  secureCookies?: boolean;
  // For tests: how to reach OpenRouter's account endpoints.
  fetch?: Fetch;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  body: Record<string, unknown>;
  params: string[];
  user: User | undefined;
  token: string | undefined;
}

type Handler = (ctx: Ctx & { user: User }) => Promise<unknown>;
type PublicHandler = (ctx: Ctx) => Promise<unknown>;

const EXAMPLE_DIRS = ["examples", "examples/planned"];
const SERVICE_STOPPED = "the engine service stopped";
const SESSION_COOKIE = "orch_session";
const PKCE_COOKIE = "orch_pkce";
const STREAMING = Symbol("streaming");

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function str(v: unknown, name: string, max = 500): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required`);
  if (v.length > max) throw new HttpError(400, `${name} is too long`);
  return v.trim();
}

function checkEmail(v: unknown): string {
  const email = str(v, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "that doesn't look like an email address");
  return email;
}

function checkNewPassword(v: unknown): string {
  if (typeof v !== "string" || v.length < 10) throw new HttpError(400, "use a password of at least 10 characters");
  if (v.length > 200) throw new HttpError(400, "that password is too long");
  return v;
}

function money(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new HttpError(400, `${name} must be between $0 and $1,000`);
  return n;
}

export async function serve(opts: ServeOptions): Promise<{ url: string; close(): Promise<void>; engine: Engine; accounts: AccountStore }> {
  const { store, root, mode } = opts;
  const fetchFn = opts.fetch ?? fetch;
  const accounts = new AccountStore(store.sql, opts.master);
  await accounts.init();
  const trees = new SavedTrees(store.sql);
  await trees.init();
  const mock = opts.mockGateway;
  if (mode === "mock" && !mock) throw new Error("mock mode needs a mock gateway");
  const makeOpenRouter = opts.openRouter ?? ((key: () => Promise<string>) => new OpenRouterGateway(key));
  const gatewayFor = (owner: string | undefined): Gateway => {
    if (mode === "mock") return mock!;
    return makeOpenRouter(async () => {
      const key = owner ? await accounts.useKey(owner, "openrouter") : undefined;
      if (!key) throw new GatewayError("no OpenRouter key is connected to this account; add one in Settings", false);
      return key;
    });
  };
  const engine = new Engine({ store, gateway: gatewayFor });
  const driving = new Map<string, Promise<unknown>>();
  const listeners = new Map<string, Set<(e: RunEvent) => void>>();
  const signInLimit = new RateLimiter(10, 10 * 60_000);
  const signUpLimit = new RateLimiter(20, 60 * 60_000);

  engine.on("event", (e) => {
    for (const fn of listeners.get(e.runId) ?? []) fn(e);
  });

  const drive = (runId: string) => {
    if (driving.has(runId)) return;
    const p = engine
      .drive(runId)
      .catch((err) => console.error(`run ${runId}: ${redact(String(err))}`))
      .finally(() => driving.delete(runId));
    driving.set(runId, p);
  };

  // Pick up runs that were going when the service last stopped.
  for (const r of await store.listRuns()) {
    const s = await engine.state(r.runId);
    const wasGoing = s.status === "running" || (s.status === "paused" && s.reason === SERVICE_STOPPED);
    if (wasGoing && s.gateway === mode) {
      await engine.resume(r.runId);
      drive(r.runId);
    }
  }

  // ---- Helpers ----

  const setCookie = (res: ServerResponse, name: string, value: string, maxAgeSeconds: number) => {
    const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (opts.secureCookies) attrs.push("Secure");
    const prev = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), attrs.join("; ")]);
  };

  const startSession = async (res: ServerResponse, user: User) => {
    const { token } = await accounts.createSession(user.id);
    setCookie(res, SESSION_COOKIE, token, SESSION_DAYS * 86_400);
  };

  const clientIp = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim();

  const loadPanel = (name: unknown): Panel => {
    if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new HttpError(400, "pick a panel");
    const path = join(root, "panels", `${name}.json`);
    if (!existsSync(path)) throw new HttpError(404, `no panel "${name}"`);
    return parsePanel(JSON.parse(readFileSync(path, "utf8")));
  };

  const limitsFrom = (body: Record<string, unknown>): Limits => ({ ...DEFAULT_LIMITS, ...(body.limits as Partial<Limits> | undefined) });

  // With real models, a user needs a key before anything can spend.
  const needKey = async (user: User) => {
    if (mode !== "openrouter") return;
    const keys = await accounts.keys(user.id);
    if (!keys.some((k) => k.provider === "openrouter")) throw new HttpError(412, "connect an OpenRouter key in Settings first");
  };

  const ownRun = async (user: User, runId: string) => {
    if ((await store.ownerOf(runId)) !== user.id) throw new HttpError(404, "no such run");
  };

  const planCap = (user: User) => usdToNanos(Math.min(user.settings.planCapUsd ?? opts.planCapUsd ?? 0.1, opts.planCapUsd ?? 1));

  // ---- Routes ----

  const open: [string, RegExp, PublicHandler][] = [
    ["GET", /^\/api\/config$/, async () => ({ gateway: mode, limits: DEFAULT_LIMITS, planCapUsd: opts.planCapUsd ?? 0.1 })],

    [
      "POST",
      /^\/api\/auth\/signup$/,
      async ({ req, res, body }) => {
        if (!signUpLimit.take(clientIp(req))) throw new HttpError(429, "too many sign-ups from here; try again later");
        const email = checkEmail(body.email);
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
        const password = checkNewPassword(body.password);
        try {
          const user = await accounts.createUser(email, name, await hashPassword(password));
          await startSession(res, user);
          return { user };
        } catch (err) {
          if (err instanceof EmailTakenError) throw new HttpError(409, "an account with that email already exists; sign in instead");
          throw err;
        }
      },
    ],

    [
      "POST",
      /^\/api\/auth\/signin$/,
      async ({ req, res, body }) => {
        const email = checkEmail(body.email);
        if (!signInLimit.take(`${clientIp(req)}|${email}`)) throw new HttpError(429, "too many attempts; wait a few minutes and try again");
        const password = typeof body.password === "string" ? body.password : "";
        const found = await accounts.findByEmail(email);
        const ok = await verifyPassword(password, found?.passwordHash ?? (await dummyHash()));
        if (!found || !ok) throw new HttpError(401, "that email and password don't match an account");
        const { passwordHash: _, ...user } = found;
        await startSession(res, user);
        return { user };
      },
    ],

    [
      "POST",
      /^\/api\/auth\/signout$/,
      async ({ res, token }) => {
        if (token) await accounts.deleteSession(token);
        setCookie(res, SESSION_COOKIE, "", 0);
        return { ok: true };
      },
    ],
  ];

  const authed: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/me$/, async ({ user }) => ({ user, keys: await accounts.keys(user.id), gateway: mode })],

    [
      "POST",
      /^\/api\/me\/profile$/,
      async ({ user, body }) => {
        const update: { name?: string; email?: string } = {};
        if (typeof body.name === "string") update.name = body.name.trim().slice(0, 100);
        if (body.email !== undefined) update.email = checkEmail(body.email);
        try {
          return { user: await accounts.updateProfile(user.id, update) };
        } catch (err) {
          if (err instanceof EmailTakenError) throw new HttpError(409, "another account already uses that email");
          throw err;
        }
      },
    ],

    [
      "POST",
      /^\/api\/me\/password$/,
      async ({ user, body, token }) => {
        const current = typeof body.current === "string" ? body.current : "";
        if (!(await verifyPassword(current, (await accounts.passwordHash(user.id)) ?? ""))) throw new HttpError(403, "your current password isn't right");
        await accounts.setPassword(user.id, await hashPassword(checkNewPassword(body.next)));
        // Other devices have to sign in again with the new password.
        if (token) await accounts.deleteOtherSessions(user.id, token);
        return { ok: true };
      },
    ],

    [
      "POST",
      /^\/api\/me\/settings$/,
      async ({ user, body }) => {
        const settings: { defaultPanel?: string; defaultCapUsd?: number; planCapUsd?: number } = {};
        if (body.defaultPanel !== undefined) {
          loadPanel(body.defaultPanel);
          settings.defaultPanel = String(body.defaultPanel);
        }
        if (body.defaultCapUsd !== undefined) settings.defaultCapUsd = money(body.defaultCapUsd, "the default spending limit");
        if (body.planCapUsd !== undefined) settings.planCapUsd = Math.min(money(body.planCapUsd, "the drafting limit"), 1);
        return { user: await accounts.updateSettings(user.id, settings) };
      },
    ],

    [
      "POST",
      /^\/api\/me\/delete$/,
      async ({ user, body, res }) => {
        const password = typeof body.password === "string" ? body.password : "";
        if (!(await verifyPassword(password, (await accounts.passwordHash(user.id)) ?? ""))) throw new HttpError(403, "your password isn't right");
        for (const r of await store.listRuns({ owner: user.id })) {
          if (driving.has(r.runId)) await engine.pause(r.runId, "the account was deleted").catch(() => {});
        }
        await Promise.allSettled([...driving.values()]);
        await accounts.deleteUser(user.id);
        setCookie(res, SESSION_COOKIE, "", 0);
        return { ok: true };
      },
    ],

    // ---- Keys ----

    ["GET", /^\/api\/keys$/, async ({ user }) => accounts.keys(user.id)],

    [
      "POST",
      /^\/api\/keys\/openrouter$/,
      async ({ user, body }) => {
        const key = str(body.key, "key", 400);
        if (!looksLikeOpenRouterKey(key)) throw new HttpError(400, "that doesn't look like an OpenRouter key (they start with sk-or-)");
        const status = await checkKey(key, fetchFn).catch((err) => {
          if (err instanceof KeyRejectedError) throw new HttpError(400, err.message);
          throw err;
        });
        const info = await accounts.putKey(user.id, "openrouter", key, "pasted");
        return { key: info, status };
      },
    ],

    [
      "POST",
      /^\/api\/keys\/openrouter\/check$/,
      async ({ user }) => {
        const key = await accounts.useKey(user.id, "openrouter");
        if (!key) throw new HttpError(404, "no OpenRouter key is connected");
        try {
          return { ok: true, status: await checkKey(key, fetchFn) };
        } catch (err) {
          if (err instanceof KeyRejectedError) return { ok: false, error: "OpenRouter no longer accepts this key. It may have been revoked; connect a new one." };
          throw err;
        }
      },
    ],

    [
      "POST",
      /^\/api\/keys\/openrouter\/connect$/,
      async ({ body, res }) => {
        const callback = str(body.callbackUrl, "callbackUrl", 500);
        if (!/^https?:\/\//.test(callback)) throw new HttpError(400, "the callback must be an http(s) URL");
        const { verifier, challenge } = newPkce();
        setCookie(res, PKCE_COOKIE, verifier, 15 * 60);
        return { url: authorizeUrl(callback, challenge) };
      },
    ],

    [
      "POST",
      /^\/api\/keys\/openrouter\/finish$/,
      async ({ user, body, req, res }) => {
        const verifier = cookies(req)[PKCE_COOKIE];
        if (!verifier) throw new HttpError(400, "the connection timed out; start it again from Settings");
        setCookie(res, PKCE_COOKIE, "", 0);
        let key: string;
        try {
          key = await exchangeCode(str(body.code, "code"), verifier, fetchFn);
        } catch (err) {
          if (err instanceof KeyRejectedError) throw new HttpError(400, err.message);
          throw err;
        }
        return { key: await accounts.putKey(user.id, "openrouter", key, "oauth") };
      },
    ],

    ["POST", /^\/api\/keys\/openrouter\/delete$/, async ({ user }) => ({ deleted: await accounts.deleteKey(user.id, "openrouter") })],

    // ---- Panels, examples and trees ----

    [
      "GET",
      /^\/api\/panels$/,
      async () =>
        readdirSync(join(root, "panels"))
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const name = f.replace(/\.json$/, "");
            return { name, panel: loadPanel(name) };
          }),
    ],

    [
      "GET",
      /^\/api\/examples$/,
      async () => {
        const goalsPath = join(root, "examples", "goals.json");
        const goals = existsSync(goalsPath) ? JSON.parse(readFileSync(goalsPath, "utf8")) : [];
        const files: { path: string; goal: string }[] = [];
        for (const dir of EXAMPLE_DIRS) {
          const full = join(root, dir);
          if (!existsSync(full)) continue;
          for (const f of readdirSync(full).filter((x) => x.endsWith(".tree.json")).sort()) {
            try {
              const t = JSON.parse(readFileSync(join(full, f), "utf8")) as { goal?: string };
              files.push({ path: `${dir}/${f}`, goal: t.goal ?? f });
            } catch {
              // Skip files that aren't valid JSON.
            }
          }
        }
        return { goals, trees: files };
      },
    ],

    [
      "GET",
      /^\/api\/tree$/,
      async ({ req }) => {
        const path = new URL(req.url!, "http://x").searchParams.get("path") ?? "";
        const full = resolve(root, path);
        const rel = relative(root, full);
        if (!EXAMPLE_DIRS.some((d) => rel.startsWith(`${d}/`) && !rel.slice(d.length + 1).includes("/")) || !rel.endsWith(".tree.json")) {
          throw new HttpError(400, "not an example tree");
        }
        if (!existsSync(full)) throw new HttpError(404, `no file ${path}`);
        return { tree: treeToJson(parseTree(JSON.parse(readFileSync(full, "utf8")))) };
      },
    ],

    ["GET", /^\/api\/trees$/, async ({ user }) => trees.list(user.id)],

    [
      "GET",
      /^\/api\/trees\/([\w-]+)$/,
      async ({ user, params }) => {
        const t = await trees.get(user.id, params[0]!);
        if (!t) throw new HttpError(404, "no such saved tree");
        return t;
      },
    ],

    [
      "POST",
      /^\/api\/trees$/,
      async ({ user, body }) => {
        const tree = parseTree(body.tree);
        const id = typeof body.id === "string" && /^[\w-]+$/.test(body.id) ? body.id : undefined;
        return trees.save(user.id, treeToJson(tree), tree.goal, id);
      },
    ],

    ["POST", /^\/api\/trees\/([\w-]+)\/delete$/, async ({ user, params }) => ({ deleted: await trees.remove(user.id, params[0]!) })],

    // ---- Drafting and checking ----

    [
      "POST",
      /^\/api\/plan$/,
      async ({ user, body }) => {
        await needKey(user);
        const panel = loadPanel(body.panel);
        const goal = str(body.goal, "goal", 2000);
        const limits = limitsFrom(body);
        const gateway = gatewayFor(user.id);
        const r = await plan({ goal, panel, limits, gateway, capNanos: planCap(user) });
        const estimate = await estimateTree(r.tree, panel, limits, (m) => gateway.price(m));
        const drafted: Drafted = { model: r.model, costNanos: r.costNanos, attempts: r.attempts.length, repairs: r.repairs };
        return { tree: treeToJson(r.tree), estimate, drafted };
      },
    ],

    // Validate an edited tree and estimate it. A broken tree isn't an HTTP
    // error here: the editor shows the problem and keeps going.
    [
      "POST",
      /^\/api\/check$/,
      async ({ user, body }) => {
        const panel = loadPanel(body.panel);
        const limits = limitsFrom(body);
        const gateway = gatewayFor(user.id);
        try {
          const tree = parseTree(body.tree);
          const { models } = checkTree(tree, panel, limits);
          for (const m of models) await gateway.price(m);
          return { ok: true, estimate: await estimateTree(tree, panel, limits, (m) => gateway.price(m)) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    ],

    // ---- Runs ----

    [
      "GET",
      /^\/api\/runs$/,
      async ({ user }) => {
        const out = [];
        for (const r of await store.listRuns({ owner: user.id })) {
          const s = await engine.state(r.runId);
          out.push({ runId: r.runId, goal: r.goal, createdAt: r.createdAt, status: s.status, spentNanos: s.spentNanos, cap: s.cap, gateway: s.gateway });
        }
        return out;
      },
    ],

    [
      "POST",
      /^\/api\/runs$/,
      async ({ user, body }) => {
        await needKey(user);
        const panel = loadPanel(body.panel);
        const tree = parseTree(body.tree);
        const createOpts: Parameters<Engine["createRun"]>[0] = {
          tree,
          panel,
          capNanos: usdToNanos(money(body.capUsd, "the spending limit")),
          limits: limitsFrom(body),
          owner: user.id,
        };
        if (typeof body.concurrency === "number") createOpts.concurrency = Math.min(8, Math.max(1, Math.floor(body.concurrency)));
        if (isDrafted(body.drafted)) createOpts.drafted = body.drafted;
        const runId = await engine.createRun(createOpts);
        await engine.start(runId);
        drive(runId);
        return { runId };
      },
    ],

    [
      "POST",
      /^\/api\/runs\/([\w-]+)\/pause$/,
      async ({ user, params }) => {
        await ownRun(user, params[0]!);
        await engine.pause(params[0]!, "paused from the browser");
        return { ok: true };
      },
    ],

    [
      "POST",
      /^\/api\/runs\/([\w-]+)\/resume$/,
      async ({ user, params, body }) => {
        const runId = params[0]!;
        await ownRun(user, runId);
        await needKey(user);
        const s = await engine.state(runId);
        if (s.gateway !== mode) {
          throw new HttpError(409, `this run used ${s.gateway === "mock" ? "mock models" : s.gateway}, and the service is now on ${mode === "mock" ? "mock models" : mode}`);
        }
        const resumeOpts: { capNanos?: number } = {};
        if (body.capUsd !== undefined) resumeOpts.capNanos = usdToNanos(money(body.capUsd, "the spending limit"));
        await engine.resume(runId, resumeOpts);
        drive(runId);
        return { ok: true };
      },
    ],

    // The run's events, from `after` (or Last-Event-ID) onwards, then live.
    [
      "GET",
      /^\/api\/runs\/([\w-]+)\/events$/,
      async ({ user, req, res, params }) => {
        const runId = params[0]!;
        await ownRun(user, runId);
        const url = new URL(req.url!, "http://x");
        let sent = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const send = (e: RunEvent) => {
          if (e.seq <= sent) return;
          sent = e.seq;
          res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        // Listen first and hold live events back, so nothing slips between
        // reading the log and switching to live.
        const held: RunEvent[] = [];
        let live = false;
        const listener = (e: RunEvent) => (live ? send(e) : held.push(e));
        let set = listeners.get(runId);
        if (!set) listeners.set(runId, (set = new Set()));
        set.add(listener);
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          set!.delete(listener);
        });
        for (const e of await store.readEvents(runId, sent)) send(e);
        for (const e of held) send(e);
        live = true;
        return STREAMING;
      },
    ],
  ];

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      const pub = open.find(([m, re]) => m === req.method && re.test(path));
      const priv = pub ? undefined : authed.find(([m, re]) => m === req.method && re.test(path));
      const route = pub ?? priv;
      if (!route) throw new HttpError(404, "not found");
      // Requests that change something must be JSON. Browsers won't send a
      // cross-site JSON request without a CORS preflight, which this service
      // never grants; together with SameSite cookies, that stops CSRF.
      if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
        throw new HttpError(415, "send JSON");
      }
      const body = req.method === "POST" ? await readBody(req) : {};
      const token = cookies(req)[SESSION_COOKIE];
      const user = token ? await accounts.userForSession(token) : undefined;
      const ctx: Ctx = { req, res, body, params: path.match(route[1])!.slice(1), user, token };
      let result: unknown;
      if (pub) result = await pub[2](ctx);
      else {
        if (!user) throw new HttpError(401, "sign in to continue");
        result = await priv![2]({ ...ctx, user });
      }
      if (result === STREAMING) return;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status =
        err instanceof HttpError ? err.status : err instanceof TreeError || err instanceof PanelError || err instanceof PlanError ? 400 : 500;
      const message = redact(err instanceof Error ? err.message : String(err));
      const ref = randomBytes(3).toString("hex");
      if (status === 500) console.error(`${req.method} ${path} [${ref}]: ${message}`);
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: status === 500 ? `something went wrong in the engine (ref ${ref})` : message }));
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(opts.port, host, r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://${host}:${port}`,
    engine,
    accounts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const runId of driving.keys()) await engine.pause(runId, SERVICE_STOPPED).catch(() => {});
      await Promise.allSettled([...driving.values()]);
    },
  };
}

function isDrafted(v: unknown): v is Drafted {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.model === "string" && typeof d.costNanos === "number" && d.costNanos >= 0 && typeof d.attempts === "number" && Array.isArray(d.repairs);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "the body must be a JSON object");
  }
}

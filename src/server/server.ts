import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { checkTree, treeToJson } from "../core/check-tree.ts";
import { estimateTree } from "../core/estimate.ts";
import type { Drafted, RunEvent } from "../core/events.ts";
import { usdToNanos } from "../core/money.ts";
import { PanelError, parsePanel, type Panel } from "../core/panel.ts";
import { DEFAULT_LIMITS, parseTree, TreeError, type Limits } from "../core/tree.ts";
import { Engine } from "../engine/engine.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { redact } from "../gateway/redact.ts";
import { plan, PlanError } from "../planner/planner.ts";
import type { Store } from "../store/store.ts";

// The engine as a small local HTTP service. The web app drafts, checks and
// starts runs through it, and follows each run as a stream of its events.

export interface ServeOptions {
  store: Store;
  gateway: Gateway;
  // The repo directory: panels/, examples/ and plans/ are read from here.
  root: string;
  port: number;
  host?: string;
  planCapUsd?: number;
  secrets?: string[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TREE_DIRS = ["examples", "examples/planned", "plans"];
const SERVICE_STOPPED = "the engine service stopped";

export async function serve(opts: ServeOptions): Promise<{ url: string; close(): Promise<void>; engine: Engine }> {
  const { store, gateway, root } = opts;
  const engine = new Engine({ store, gateway });
  const driving = new Map<string, Promise<unknown>>();
  const listeners = new Map<string, Set<(e: RunEvent) => void>>();

  engine.on("event", (e) => {
    for (const fn of listeners.get(e.runId) ?? []) fn(e);
  });

  const drive = (runId: string) => {
    if (driving.has(runId)) return;
    const p = engine
      .drive(runId)
      .catch((err) => console.error(`run ${runId}: ${redact(String(err), opts.secrets)}`))
      .finally(() => driving.delete(runId));
    driving.set(runId, p);
  };

  // Pick up runs that were going when the service last stopped: ones it
  // paused on the way down, and ones left running by a crash.
  for (const r of await store.listRuns()) {
    const s = await engine.state(r.runId);
    const wasGoing = s.status === "running" || (s.status === "paused" && s.reason === SERVICE_STOPPED);
    if (wasGoing && s.gateway === gateway.name) {
      await engine.resume(r.runId);
      drive(r.runId);
    }
  }

  const loadPanel = (name: unknown): Panel => {
    if (typeof name !== "string" || !/^[\w-]+$/.test(name)) throw new HttpError(400, "pick a panel");
    const path = join(root, "panels", `${name}.json`);
    if (!existsSync(path)) throw new HttpError(404, `no panel "${name}"`);
    return parsePanel(JSON.parse(readFileSync(path, "utf8")));
  };

  const limitsFrom = (body: Record<string, unknown>): Limits => ({ ...DEFAULT_LIMITS, ...(body.limits as Partial<Limits> | undefined) });

  const routes: [string, RegExp, (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, body: Record<string, unknown>) => Promise<unknown>][] = [
    ["GET", /^\/api\/config$/, async () => ({ gateway: gateway.name, limits: DEFAULT_LIMITS, planCapUsd: opts.planCapUsd ?? 0.1 })],

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
        const trees: { path: string; goal: string }[] = [];
        for (const dir of TREE_DIRS) {
          const full = join(root, dir);
          if (!existsSync(full)) continue;
          for (const f of readdirSync(full).filter((x) => x.endsWith(".tree.json")).sort()) {
            try {
              const t = JSON.parse(readFileSync(join(full, f), "utf8")) as { goal?: string };
              trees.push({ path: `${dir}/${f}`, goal: t.goal ?? f });
            } catch {
              // Skip files that aren't valid JSON.
            }
          }
        }
        return { goals, trees };
      },
    ],

    [
      "GET",
      /^\/api\/tree$/,
      async (req) => {
        const path = new URL(req.url!, "http://x").searchParams.get("path") ?? "";
        const full = resolve(root, path);
        const rel = relative(root, full);
        if (!TREE_DIRS.some((d) => rel.startsWith(`${d}/`) && !rel.slice(d.length + 1).includes("/")) || !rel.endsWith(".tree.json")) {
          throw new HttpError(400, "not a tree file orch knows about");
        }
        if (!existsSync(full)) throw new HttpError(404, `no file ${path}`);
        return { tree: treeToJson(parseTree(JSON.parse(readFileSync(full, "utf8")))) };
      },
    ],

    [
      "POST",
      /^\/api\/plan$/,
      async (_req, _res, _m, body) => {
        const panel = loadPanel(body.panel);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (!goal) throw new HttpError(400, "write a goal first");
        const limits = limitsFrom(body);
        const r = await plan({ goal, panel, limits, gateway, capNanos: usdToNanos(opts.planCapUsd ?? 0.1) });
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
      async (_req, _res, _m, body) => {
        const panel = loadPanel(body.panel);
        const limits = limitsFrom(body);
        try {
          const tree = parseTree(body.tree);
          const { models } = checkTree(tree, panel, limits);
          for (const m of models) await gateway.price(m);
          const estimate = await estimateTree(tree, panel, limits, (m) => gateway.price(m));
          return { ok: true, estimate };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    ],

    [
      "POST",
      /^\/api\/trees$/,
      async (_req, _res, _m, body) => {
        const tree = parseTree(body.tree);
        const name =
          (typeof body.name === "string" ? body.name : tree.goal)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 6)
            .join("-") || "plan";
        mkdirSync(join(root, "plans"), { recursive: true });
        const path = `plans/${name}.tree.json`;
        writeFileSync(join(root, path), JSON.stringify(treeToJson(tree), null, 2) + "\n");
        return { path };
      },
    ],

    [
      "GET",
      /^\/api\/runs$/,
      async () => {
        const out = [];
        for (const r of await store.listRuns()) {
          const s = await engine.state(r.runId);
          out.push({ runId: r.runId, goal: r.goal, createdAt: r.createdAt, status: s.status, spentNanos: s.spentNanos, cap: s.cap, gateway: s.gateway });
        }
        return out;
      },
    ],

    [
      "POST",
      /^\/api\/runs$/,
      async (_req, _res, _m, body) => {
        const panel = loadPanel(body.panel);
        const tree = parseTree(body.tree);
        const cap = Number(body.capUsd);
        if (!Number.isFinite(cap) || cap <= 0) throw new HttpError(400, "set a cap above zero");
        const createOpts: Parameters<Engine["createRun"]>[0] = { tree, panel, capNanos: usdToNanos(cap), limits: limitsFrom(body) };
        if (typeof body.concurrency === "number") createOpts.concurrency = body.concurrency;
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
      async (_req, _res, m) => {
        await engine.pause(m[1]!, "paused from the browser");
        return { ok: true };
      },
    ],

    [
      "POST",
      /^\/api\/runs\/([\w-]+)\/resume$/,
      async (_req, _res, m, body) => {
        const runId = m[1]!;
        const s = await engine.state(runId);
        if (s.gateway !== gateway.name) throw new HttpError(409, `this run used the ${s.gateway} gateway; this service runs ${gateway.name}`);
        const resumeOpts: { capNanos?: number } = {};
        if (body.capUsd !== undefined) {
          const cap = Number(body.capUsd);
          if (!Number.isFinite(cap) || cap <= 0) throw new HttpError(400, "set a cap above zero");
          resumeOpts.capNanos = usdToNanos(cap);
        }
        await engine.resume(runId, resumeOpts);
        drive(runId);
        return { ok: true };
      },
    ],

    // The run's events, from `after` (or Last-Event-ID) onwards, then live.
    [
      "GET",
      /^\/api\/runs\/([\w-]+)\/events$/,
      async (req, res, m) => {
        const runId = m[1]!;
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
    const route = routes.find(([method, re]) => method === req.method && re.test(path));
    try {
      if (!route) throw new HttpError(404, "not found");
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await route[2](req, res, path.match(route[1])!, body);
      if (result === STREAMING) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status =
        err instanceof HttpError ? err.status : err instanceof TreeError || err instanceof PanelError || err instanceof PlanError ? 400 : 500;
      const message = redact(err instanceof Error ? err.message : String(err), opts.secrets);
      if (status === 500) console.error(`${req.method} ${path}: ${message}`);
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(opts.port, host, r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://${host}:${port}`,
    engine,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const runId of driving.keys()) await engine.pause(runId, SERVICE_STOPPED).catch(() => {});
      await Promise.allSettled([...driving.values()]);
    },
  };
}

const STREAMING = Symbol("streaming");

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

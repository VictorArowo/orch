#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { treeToJson } from "../core/check-tree.ts";
import { estimateTree } from "../core/estimate.ts";
import type { Drafted } from "../core/events.ts";
import { formatUsd, usdToNanos } from "../core/money.ts";
import { modelsOf, parsePanel, type Panel } from "../core/panel.ts";
import {
  isLeaf,
  outputOf,
  isStale,
  treeOrder,
  type RunState,
} from "../core/state.ts";
import {
  DEFAULT_LIMITS,
  parseTree,
  type Limits,
  type Tree,
} from "../core/tree.ts";
import {
  plan,
  PlanError,
  planRole,
  type PlanResult,
} from "../planner/planner.ts";
import { Engine } from "../engine/engine.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { hash, MockGateway } from "../gateway/mock.ts";
import { OpenRouterGateway } from "../gateway/openrouter.ts";
import { redact } from "../gateway/redact.ts";
import { describeTarget, openStore } from "../store/open.ts";
import type { Store } from "../store/store.ts";
import { modelsUsed, renderPlan, renderSummary, renderTree } from "./render.ts";

const USAGE = `orch: run a tree of steps with the roles and models you choose.

Usage:
  orch plan "<goal>" --panel <panel.json> [--out <file>] [--plan-cap <usd>]
  orch run <tree.json> --panel <panel.json> --cap <usd> [options]
  orch run --goal "<goal>" --panel <panel.json> --cap <usd> [--yes] [options]
  orch resume <run-id> [--cap <usd>]
  orch rerun <run-id> <step-id>... [--model <id>]
  orch show <run-id> [<step-id>]
  orch runs

Options for plan and run:
  --mock               use the built-in mock models (no key, no network, no cost)
  --plan-cap <usd>     most that drafting a tree may spend (default 0.10)
  --out <file>         where to save a drafted tree (default plans/<goal>.tree.json)
  --yes                run a drafted tree without asking first
  --concurrency <n>    steps running at once (default 4)
  --max-depth <n>      tree depth limit (default 4)
  --max-fan-out <n>    children per step limit (default 8)
  --max-steps <n>      total steps limit (default 60)

Options for every command:
  --db <target>        a postgres:// URL or a directory for the embedded database
                       (default: DATABASE_URL, else .orch/db)
  --no-live            print events line by line instead of a live tree
`;

type Flags = {
  panel?: string;
  cap?: string;
  mock?: boolean;
  concurrency?: string;
  "max-depth"?: string;
  "max-fan-out"?: string;
  "max-steps"?: string;
  db?: string;
  model?: string;
  goal?: string;
  out?: string;
  "plan-cap"?: string;
  yes?: boolean;
  "no-live"?: boolean;
  help?: boolean;
};

class UsageError extends Error {}

function loadEnv() {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`${path} isn't valid JSON: ${(err as Error).message}`);
  }
}

function money(flag: string | undefined, name: string): number {
  const n = Number(flag);
  if (flag === undefined || !Number.isFinite(n) || n <= 0)
    throw new UsageError(`${name} needs a positive amount in USD, e.g. 0.50`);
  return usdToNanos(n);
}

function int(flag: string | undefined): number | undefined {
  if (flag === undefined) return undefined;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(`expected a positive whole number, got "${flag}"`);
  return n;
}

async function connect(flags: Flags): Promise<Store> {
  const target = flags.db ?? process.env.DATABASE_URL ?? ".orch/db";
  try {
    return await openStore(target);
  } catch (err) {
    const hint = target.startsWith("postgres")
      ? " Is it running? Start it with `pnpm db:up`, or unset DATABASE_URL to use the embedded database."
      : "";
    throw new Error(
      `couldn't open the database at ${describeTarget(target)}: ${(err as Error).message}.${hint}`,
    );
  }
}

function gatewayFor(kind: string): Gateway {
  if (kind === "mock") {
    // Vary the delay per call so the live view looks like real work.
    return new MockGateway({
      latency: (req) =>
        300 + (hash(req.messages.map((m) => m.content).join()) % 1200),
    });
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key)
    throw new UsageError(
      "OPENROUTER_API_KEY isn't set. Put it in .env (see .env.example), or pass --mock.",
    );
  return new OpenRouterGateway(key);
}

// Show the tree while the run works: redrawn in place on a terminal, or as
// one line per event when output is piped.
function watch(engine: Engine, runId: string, live: boolean): () => void {
  const width = () => process.stdout.columns || 120;
  if (!live) {
    const handler = (
      e: { type: string; seq: number } & Record<string, unknown>,
    ) => {
      const bits = [e.type, e.stepId ?? e.attemptId ?? e.callId ?? ""].filter(
        Boolean,
      );
      if (e.type === "call.finished")
        bits.push(formatUsd(e.costNanos as number));
      if (e.type === "review.decided") bits.push(String(e.verdict));
      if (e.type === "run.paused" || e.type === "run.stopped")
        bits.push(String(e.reason));
      console.log(bits.join("  "));
    };
    engine.on("event", handler as never);
    return () => engine.off("event", handler as never);
  }
  let drawn = 0;
  let state: RunState | undefined;
  const draw = () => {
    if (!state) return;
    const lines = renderTree(state, { color: true, width: width() });
    let out = drawn ? `\x1b[${drawn}A\x1b[0J` : "";
    out += lines.join("\n") + "\n";
    process.stdout.write(out);
    drawn = lines.length;
  };
  const refresh = () =>
    engine.state(runId).then(
      (s) => (state = s),
      () => {},
    );
  const onEvent = () => void refresh();
  engine.on("event", onEvent);
  process.stdout.write("\x1b[?25l");
  void refresh().then(draw);
  const timer = setInterval(draw, 120);
  return () => {
    clearInterval(timer);
    engine.off("event", onEvent);
    draw();
    process.stdout.write("\x1b[?25h");
  };
}

async function driveWithUi(
  engine: Engine,
  runId: string,
  flags: Flags,
): Promise<RunState> {
  const live = !flags["no-live"] && process.stdout.isTTY === true;
  const stop = watch(engine, runId, live);
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      void engine.pause(runId, "paused from the keyboard");
    } else {
      process.stdout.write("\x1b[?25h\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    return await engine.drive(runId);
  } finally {
    process.off("SIGINT", onSigint);
    stop();
  }
}

function report(state: RunState) {
  const width = process.stdout.columns || 120;
  const color = process.stdout.isTTY === true;
  console.log("");
  for (const line of renderSummary(state, { color, width })) console.log(line);
  console.log("");
  if (state.status === "done") {
    console.log(`Result (${state.rootId}):\n`);
    console.log(outputOf(state, state.rootId));
    const stale = treeOrder(state).filter(
      (id) => isLeaf(state.steps[id]!) && isStale(state, id),
    );
    if (stale.length) {
      console.log(
        `\nStale: ${stale.join(", ")} read outputs that have since changed.`,
      );
      console.log(
        `Re-run them with: orch rerun ${state.runId} ${stale.join(" ")}`,
      );
    }
  } else if (state.status === "paused") {
    console.log(`Paused: ${state.reason}.`);
    if (state.neededNanos) {
      const left = Math.max(0, state.cap - state.spentNanos);
      console.log(
        `The next call needs up to ${formatUsd(state.neededNanos)} and ${formatUsd(left)} is left.`,
      );
    }
    console.log(
      `Resume with: orch resume ${state.runId}${state.neededNanos ? " --cap <usd>" : ""}`,
    );
  } else if (state.status === "stopped") {
    console.log(`Stopped: ${state.reason}`);
  }
}

function limitsFrom(flags: Flags): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS };
  const depth = int(flags["max-depth"]);
  const fan = int(flags["max-fan-out"]);
  const steps = int(flags["max-steps"]);
  if (depth) limits.maxDepth = depth;
  if (fan) limits.maxFanOut = fan;
  if (steps) limits.maxSteps = steps;
  return limits;
}

const DEFAULT_PLAN_CAP_USD = 0.1;

// Ask the panel's plan role for a tree, print it with estimates, and save it
// as an editable file.
async function draftTree(
  goal: string,
  panel: Panel,
  limits: Limits,
  gateway: Gateway,
  planCap: number,
  out?: string,
) {
  const width = process.stdout.columns || 120;
  const color = process.stdout.isTTY === true;
  const role = planRole(panel);
  console.log(`Drafting with ${role.name} (${modelsOf(role.models)[0]})…`);
  let result: PlanResult;
  try {
    result = await plan({ goal, panel, limits, gateway, capNanos: planCap });
  } catch (err) {
    if (err instanceof PlanError) {
      for (const [i, a] of err.attempts.entries())
        for (const p of a.problems) console.error(`  attempt ${i + 1}: ${p}`);
    }
    throw err;
  }
  const n = result.attempts.length;
  console.log(
    `Drafted in ${n} attempt${n > 1 ? "s" : ""} for ${formatUsd(result.costNanos)}.`,
  );
  for (const r of result.repairs) console.log(`  repaired: ${r}`);
  console.log("");
  const estimate = await estimateTree(result.tree, panel, limits, (m) =>
    gateway.price(m),
  );
  for (const line of renderPlan(result.tree, panel, estimate, { color, width }))
    console.log(line);
  const path = out ?? freePath(`plans/${slugify(goal)}.tree.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(treeToJson(result.tree), null, 2) + "\n");
  console.log(`\nSaved to ${path}`);
  return { result, estimate, path };
}

function slugify(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join("-") || "plan"
  );
}

function freePath(path: string): string {
  if (!existsSync(path)) return path;
  const base = path.replace(/\.tree\.json$/, "");
  for (let i = 2; ; i++)
    if (!existsSync(`${base}-${i}.tree.json`)) return `${base}-${i}.tree.json`;
}

// A cap suggestion: the high estimate rounded up to a tidy amount.
function suggestCap(highNanos: number): string {
  const usd = highNanos / 1e9;
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
  return (steps.find((s) => s >= usd) ?? Math.ceil(usd)).toFixed(2);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function cmdPlan(args: string[], flags: Flags) {
  const goal = args.join(" ").trim();
  if (!goal || !flags.panel)
    throw new UsageError(
      'plan needs a goal and --panel, e.g. orch plan "Compare..." --panel panels/starter.json',
    );
  const panel = parsePanel(readJson(flags.panel));
  const limits = limitsFrom(flags);
  const gateway = gatewayFor(flags.mock ? "mock" : "openrouter");
  const planCap =
    flags["plan-cap"] !== undefined
      ? money(flags["plan-cap"], "--plan-cap")
      : usdToNanos(DEFAULT_PLAN_CAP_USD);
  const { estimate, path } = await draftTree(
    goal,
    panel,
    limits,
    gateway,
    planCap,
    flags.out,
  );
  console.log(`Edit it if you like, then run it with:`);
  console.log(
    `  orch run ${path} --panel ${flags.panel} --cap ${suggestCap(estimate.total.high)}${flags.mock ? " --mock" : ""}`,
  );
}

async function cmdRun(args: string[], flags: Flags) {
  const [treePath] = args;
  if (!flags.panel) throw new UsageError("run needs --panel");
  if (!treePath && !flags.goal)
    throw new UsageError("run needs a tree file or --goal");
  const panel = parsePanel(readJson(flags.panel));
  const capNanos = money(flags.cap, "--cap");
  const limits = limitsFrom(flags);
  const gateway = gatewayFor(flags.mock ? "mock" : "openrouter");

  let tree: Tree;
  let drafted: Drafted | undefined;
  if (flags.goal) {
    if (treePath)
      throw new UsageError("pass either a tree file or --goal, not both");
    const planCap = Math.min(
      capNanos,
      flags["plan-cap"] !== undefined
        ? money(flags["plan-cap"], "--plan-cap")
        : usdToNanos(DEFAULT_PLAN_CAP_USD),
    );
    const d = await draftTree(
      flags.goal,
      panel,
      limits,
      gateway,
      planCap,
      flags.out,
    );
    tree = d.result.tree;
    drafted = {
      model: d.result.model,
      costNanos: d.result.costNanos,
      attempts: d.result.attempts.length,
      repairs: d.result.repairs,
    };
    if (d.estimate.total.high + d.result.costNanos > capNanos) {
      console.log(
        `The high estimate is above the ${formatUsd(capNanos)} cap, so the run may pause before it finishes.`,
      );
    }
    if (!flags.yes) {
      if (!process.stdin.isTTY)
        throw new UsageError(
          "pass --yes to run a drafted tree without confirming",
        );
      if (!(await confirm(`Run it with a ${formatUsd(capNanos)} cap?`))) {
        console.log(`Not running. The tree is saved at ${d.path}.`);
        return;
      }
    }
  } else {
    tree = parseTree(readJson(treePath!));
    const estimate = await estimateTree(tree, panel, limits, (m) =>
      gateway.price(m),
    );
    console.log(
      `Estimate ${formatUsd(estimate.total.low)}–${formatUsd(estimate.total.high)} against a ${formatUsd(capNanos)} cap.`,
    );
  }

  const store = await connect(flags);
  try {
    const engine = new Engine({ store, gateway });
    const opts: Parameters<Engine["createRun"]>[0] = {
      tree,
      panel,
      capNanos,
      limits,
    };
    const concurrency = int(flags.concurrency);
    if (concurrency) opts.concurrency = concurrency;
    if (drafted) opts.drafted = drafted;
    const runId = await engine.createRun(opts);
    await engine.start(runId);
    report(await driveWithUi(engine, runId, flags));
  } finally {
    await store.close();
  }
}

async function withRun(
  runId: string | undefined,
  flags: Flags,
  fn: (engine: Engine, state: RunState) => Promise<void>,
) {
  if (!runId)
    throw new UsageError("which run? Pass a run id (see `orch runs`)");
  const store = await connect(flags);
  try {
    const events = await store.readEvents(runId, 0);
    const created = events[0];
    if (!created || created.type !== "run.created")
      throw new UsageError(`no run "${runId}"`);
    const engine = new Engine({ store, gateway: gatewayFor(created.gateway) });
    await fn(engine, await engine.state(runId));
  } finally {
    await store.close();
  }
}

async function cmdResume(args: string[], flags: Flags) {
  await withRun(args[0], flags, async (engine, state) => {
    const opts: { capNanos?: number } = {};
    if (flags.cap !== undefined) opts.capNanos = money(flags.cap, "--cap");
    await engine.resume(state.runId, opts);
    report(await driveWithUi(engine, state.runId, flags));
  });
}

async function cmdRerun(args: string[], flags: Flags) {
  const [runId, ...steps] = args;
  if (!steps.length) throw new UsageError("rerun needs at least one step id");
  await withRun(runId, flags, async (engine, state) => {
    const opts: { model?: string } = {};
    if (flags.model) opts.model = flags.model;
    await engine.rerun(state.runId, steps, opts);
    report(await driveWithUi(engine, state.runId, flags));
  });
}

async function cmdShow(args: string[], flags: Flags) {
  const [runId, stepId] = args;
  await withRun(runId, flags, async (_engine, state) => {
    const width = process.stdout.columns || 120;
    const color = process.stdout.isTTY === true;
    if (!stepId) {
      for (const line of renderTree(state, { color, width })) console.log(line);
      for (const line of renderSummary(state, { color, width }))
        console.log(line);
      return;
    }
    const step = state.steps[stepId];
    if (!step) throw new UsageError(`no step "${stepId}"`);
    console.log(`${step.id}: ${step.spec.title} (${step.spec.mode})`);
    if (step.spec.instructions) console.log(`\n${step.spec.instructions}`);
    if (!isLeaf(step)) {
      console.log(`\n${outputOf(state, stepId)}`);
      return;
    }
    console.log(
      `\nModels: ${modelsUsed(state, step).join(" → ") || "none yet"}`,
    );
    for (const id of step.attemptIds) {
      const a = state.attempts[id]!;
      console.log(
        `\n── ${a.id} · ${a.role} · ${a.model} · ${a.reason} · ${a.status}`,
      );
      if (a.notes.length)
        console.log(`notes:\n${a.notes.map((n) => `  - ${n}`).join("\n")}`);
      for (const c of a.callIds.map((x) => state.calls[x]!)) {
        const usage = c.usage
          ? ` · ${c.usage.promptTokens}+${c.usage.completionTokens} tokens`
          : "";
        console.log(
          `  call ${c.id} · ${c.purpose} · ${c.model} · ${c.status} · reserved ${formatUsd(c.reservedNanos)} · cost ${formatUsd(c.costNanos)}${usage}`,
        );
        if (c.error) console.log(`    error: ${c.error}`);
      }
      for (const r of a.reviews) {
        console.log(`  ${r.purpose} by ${r.role}: ${r.verdict}`);
        if (r.votes.length > 1)
          for (const v of r.votes) console.log(`    ${v.model}: ${v.verdict}`);
        for (const n of r.notes) console.log(`    - ${n}`);
      }
      if (a.output !== undefined) console.log(`\n${a.output}`);
    }
  });
}

async function cmdRuns(flags: Flags) {
  const store = await connect(flags);
  try {
    const runs = await store.listRuns();
    if (!runs.length) console.log("No runs yet.");
    for (const r of runs)
      console.log(
        `${r.runId}  ${r.createdAt.slice(0, 16).replace("T", " ")}  ${r.goal}`,
      );
  } finally {
    await store.close();
  }
}

async function main() {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      panel: { type: "string" },
      cap: { type: "string" },
      mock: { type: "boolean" },
      concurrency: { type: "string" },
      "max-depth": { type: "string" },
      "max-fan-out": { type: "string" },
      "max-steps": { type: "string" },
      db: { type: "string" },
      model: { type: "string" },
      goal: { type: "string" },
      out: { type: "string" },
      "plan-cap": { type: "string" },
      yes: { type: "boolean", short: "y" },
      "no-live": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const flags = values as Flags;
  const [cmd, ...args] = positionals;
  if (!cmd || flags.help) {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "plan":
      return cmdPlan(args, flags);
    case "run":
      return cmdRun(args, flags);
    case "resume":
      return cmdResume(args, flags);
    case "rerun":
      return cmdRerun(args, flags);
    case "show":
      return cmdShow(args, flags);
    case "runs":
      return cmdRuns(flags);
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main().catch((err: unknown) => {
  const secret = process.env.OPENROUTER_API_KEY
    ? [process.env.OPENROUTER_API_KEY]
    : [];
  const message = redact(
    err instanceof Error ? err.message : String(err),
    secret,
  );
  console.error(`orch: ${message}`);
  if (err instanceof UsageError) console.error("Run `orch --help` for usage.");
  process.exitCode = 1;
});

// Plan every goal in a goals file and print one row per goal, for tuning the
// planner. Trees are saved so they can be read and compared.
//
//   pnpm plan:goals --mock
//   pnpm plan:goals --panel panels/starter.json --cap 0.50 --out .orch/plans
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { treeToJson } from "../src/core/check-tree.js";
import { estimateTree } from "../src/core/estimate.js";
import { formatUsd, usdToNanos } from "../src/core/money.js";
import { parsePanel } from "../src/core/panel.js";
import { DEFAULT_LIMITS, walk, type StepSpec } from "../src/core/tree.js";
import type { Gateway } from "../src/gateway/gateway.js";
import { MockGateway } from "../src/gateway/mock.js";
import { OpenRouterGateway } from "../src/gateway/openrouter.js";
import { plan, PlanError } from "../src/planner/planner.js";

interface Goal {
  id: string;
  goal: string;
  expect: string;
  maxSteps: number;
}

const { values } = parseArgs({
  options: {
    goals: { type: "string", default: "examples/goals.json" },
    panel: { type: "string", default: "panels/starter.json" },
    cap: { type: "string", default: "0.50" },
    out: { type: "string", default: ".orch/plans" },
    only: { type: "string" },
    mock: { type: "boolean", default: false },
  },
});

if (existsSync(".env")) process.loadEnvFile(".env");
const goals = (JSON.parse(readFileSync(values.goals, "utf8")) as Goal[]).filter((g) => !values.only || values.only.split(",").includes(g.id));
const panel = parsePanel(JSON.parse(readFileSync(values.panel, "utf8")));
const cap = usdToNanos(Number(values.cap));
let gateway: Gateway;
if (values.mock) gateway = new MockGateway();
else {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY isn't set; put it in .env or pass --mock");
  gateway = new OpenRouterGateway(key);
}
mkdirSync(values.out, { recursive: true });

const shape = (root: StepSpec) => {
  let steps = 0;
  let depth = 0;
  let fanOuts = 0;
  let reviews = 0;
  walk(root, (s, d) => {
    steps++;
    depth = Math.max(depth, d);
    if (s.mode === "parallel") fanOuts++;
    if (s.check) reviews++;
    if (s.critique) reviews++;
  });
  return { steps, depth, fanOuts, reviews };
};

let spent = 0;
const rows: string[][] = [["goal", "tries", "repairs", "steps", "depth", "fan-outs", "reviews", "estimate", "drafting", "note"]];
for (const g of goals) {
  const left = cap - spent;
  if (left <= 0) {
    rows.push([g.id, "-", "-", "-", "-", "-", "-", "-", "-", "skipped: cap reached"]);
    continue;
  }
  try {
    const r = await plan({ goal: g.goal, panel, limits: DEFAULT_LIMITS, gateway, capNanos: left });
    spent += r.costNanos;
    const s = shape(r.tree.root);
    const est = await estimateTree(r.tree, panel, DEFAULT_LIMITS, (m) => gateway.price(m));
    writeFileSync(join(values.out, `${g.id}.tree.json`), JSON.stringify(treeToJson(r.tree), null, 2) + "\n");
    rows.push([
      g.id,
      String(r.attempts.length),
      String(r.repairs.length),
      String(s.steps),
      String(s.depth),
      String(s.fanOuts),
      String(s.reviews),
      `${formatUsd(est.total.low)}–${formatUsd(est.total.high)}`,
      formatUsd(r.costNanos),
      s.steps > g.maxSteps ? `more than the ${g.maxSteps} steps expected` : "",
    ]);
  } catch (err) {
    if (err instanceof PlanError) spent += err.attempts.reduce((n, a) => n + a.costNanos, 0);
    rows.push([g.id, "-", "-", "-", "-", "-", "-", "-", "-", `failed: ${(err as Error).message.slice(0, 80)}`]);
  }
}

const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
console.log(`\nSpent ${formatUsd(spent)} of ${formatUsd(cap)} on drafting. Trees are in ${values.out}/.`);

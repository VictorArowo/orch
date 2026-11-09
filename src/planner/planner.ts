import { worstCase } from "../core/budget.js";
import { checkTree } from "../core/check-tree.js";
import type { ChatMessage, Usage } from "../core/events.js";
import { costOf, formatUsd, type Nanos } from "../core/money.js";
import { modelsOf, PanelError, type Panel, type Role } from "../core/panel.js";
import { extractJson } from "../core/prompt.js";
import { parseTree, type Limits, type Tree } from "../core/tree.js";
import { GatewayError, type Gateway } from "../gateway/gateway.js";
import { redact } from "../gateway/redact.js";
import { planMessages, retryMessage } from "./prompt.js";
import { repairPlan } from "./repair.js";

export interface PlanOptions {
  goal: string;
  panel: Panel;
  limits: Limits;
  gateway: Gateway;
  // Spending limit for planning, across all attempts.
  capNanos: Nanos;
  maxAttempts?: number;
}

export interface PlanAttempt {
  model: string;
  output: string;
  usage?: Usage;
  costNanos: Nanos;
  repairs: string[];
  problems: string[];
}

export interface PlanResult {
  tree: Tree;
  model: string;
  attempts: PlanAttempt[];
  costNanos: Nanos;
  repairs: string[];
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly attempts: PlanAttempt[],
  ) {
    super(message);
  }
}

const DEFAULT_PLAN_TOKENS = 4000;

export function planRole(panel: Panel): Role {
  const role = panel.roles.find((r) => r.job === "plan");
  if (!role) throw new PanelError(`panel "${panel.name}" has no plan role, so it can't draft a tree`);
  return role;
}

// Turn a goal into a tree: ask the plan role, repair small slips, validate,
// and if it still doesn't pass, ask again with the problems listed.
export async function plan(opts: PlanOptions): Promise<PlanResult> {
  const { goal, panel, limits, gateway } = opts;
  const role = planRole(panel);
  const model = modelsOf(role.models)[0]!;
  const price = await gateway.price(model);
  const maxTokens = role.settings.maxTokens ?? DEFAULT_PLAN_TOKENS;
  const maxAttempts = opts.maxAttempts ?? 3;
  let messages: ChatMessage[] = planMessages({ goal, panel, limits, planner: role });
  const attempts: PlanAttempt[] = [];
  let spent = 0;

  for (let n = 1; n <= maxAttempts; n++) {
    const reserve = worstCase(price, messages, maxTokens);
    if (spent + reserve > opts.capNanos) {
      throw new PlanError(
        `planning needs up to ${formatUsd(reserve)} for attempt ${n}, and ${formatUsd(Math.max(0, opts.capNanos - spent))} of the planning cap is left`,
        attempts,
      );
    }
    let text: string;
    const attempt: PlanAttempt = { model, output: "", costNanos: 0, repairs: [], problems: [] };
    attempts.push(attempt);
    try {
      const res = await gateway.complete({
        model,
        messages,
        maxTokens,
        settings: role.settings,
        meta: { purpose: "plan", stepId: "plan", output: "text" },
      });
      text = res.text;
      attempt.output = text;
      attempt.usage = res.usage;
      attempt.costNanos = res.costNanos ?? costOf(price, res.usage.promptTokens, res.usage.completionTokens);
      spent += attempt.costNanos;
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      attempt.problems.push(`call failed: ${message}`);
      if (err instanceof GatewayError && !err.retryable) throw new PlanError(`the planner call failed: ${message}`, attempts);
      continue;
    }

    try {
      const raw = extractJson(text, "{");
      const { value, repairs } = repairPlan(raw, { goal, panel, limits });
      attempt.repairs = repairs;
      const tree = parseTree(value);
      checkTree(tree, panel, limits);
      return { tree, model, attempts, costNanos: spent, repairs };
    } catch (err) {
      attempt.problems.push(err instanceof Error ? err.message : String(err));
      messages = [...messages, { role: "assistant", content: text }, retryMessage(attempt.problems)];
    }
  }
  const last = attempts[attempts.length - 1];
  throw new PlanError(`no usable plan after ${attempts.length} attempts: ${last?.problems.join("; ") ?? "no reply"}`, attempts);
}

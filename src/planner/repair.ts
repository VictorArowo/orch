import { findRole, type Job, type Panel } from "../core/panel.js";
import type { Limits } from "../core/tree.js";

// Cheap, safe fixes for common slips in a model's plan, applied before
// validation. Anything that would change what the plan means (too deep, too
// wide, steps waiting on each other) is left for validation to reject, so the
// planner gets asked again with the errors.

type Obj = Record<string, unknown>;

const STEP_KEYS = new Set([
  "id",
  "title",
  "mode",
  "instructions",
  "role",
  "model",
  "inputs",
  "output",
  "check",
  "critique",
  "maxRetries",
  "critiqueRounds",
  "maxTokens",
  "children",
  "items",
  "itemsFrom",
  "template",
]);

const MODE_ALIASES: Record<string, "leaf" | "sequence" | "parallel"> = {
  leaf: "leaf",
  task: "leaf",
  single: "leaf",
  step: "leaf",
  sequence: "sequence",
  sequential: "sequence",
  serial: "sequence",
  series: "sequence",
  parallel: "parallel",
  concurrent: "parallel",
  "fan-out": "parallel",
  fanout: "parallel",
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function repairPlan(raw: unknown, ctx: { goal: string; panel: Panel; limits: Limits }): { value: unknown; repairs: string[] } {
  const repairs: string[] = [];
  if (!isObj(raw)) return { value: raw, repairs };

  let plan: Obj = raw;
  if (!("root" in plan) && ["mode", "children", "items", "itemsFrom", "instructions", "title"].some((k) => k in plan)) {
    plan = { root: plan };
    repairs.push("wrapped a bare step as the root");
  }
  for (const k of Object.keys(plan)) {
    if (!["goal", "root", "version"].includes(k)) {
      delete plan[k];
      repairs.push(`removed unknown top-level field "${k}"`);
    }
  }
  // The run is for the user's goal, whatever the model wrote back.
  plan.goal = ctx.goal;
  plan.version = 1;
  if (!isObj(plan.root)) return { value: plan, repairs };

  const roleFix = (step: Obj, key: "role" | "check" | "critique", job: Job, label: string) => {
    const v = step[key];
    if (v === undefined) return;
    const name = typeof v === "string" ? v : "";
    const exact = findRole(ctx.panel, name);
    const loose = exact ?? ctx.panel.roles.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    if (loose && loose.job === job) {
      if (loose.name !== v) repairs.push(`${label}: "${String(v)}" read as role "${loose.name}"`);
      step[key] = loose.name;
      return;
    }
    delete step[key];
    repairs.push(`${label}: dropped ${key} "${String(v)}", which isn't a ${job} role in the panel`);
  };

  // `name` is the id the parser will give the step (or, inside a template,
  // the id of the fan-out that owns it); it only labels the repairs.
  const fixStep = (step: Obj, defaultId: string, inTemplate: boolean, owner = "") => {
    const early: string[] = [];
    if (step.id !== undefined) {
      if (inTemplate) {
        delete step.id;
        early.push("removed an id inside a template");
      } else if (typeof step.id === "string") {
        const clean = step.id
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9_-]/g, "")
          .replace(/^[-_]+/, "");
        if (!clean) delete step.id;
        else if (clean !== step.id) {
          repairs.push(`id "${step.id}" became "${clean}"`);
          step.id = clean;
        }
      }
    }
    const name = typeof step.id === "string" ? step.id : defaultId;
    const label = inTemplate ? `step ${owner} template` : `step ${name}`;
    for (const r of early) repairs.push(`${label}: ${r}`);
    for (const k of Object.keys(step)) {
      if (!STEP_KEYS.has(k)) {
        delete step[k];
        repairs.push(`${label}: removed unknown field "${k}"`);
      }
    }
    if (typeof step.mode === "string") {
      const m = MODE_ALIASES[step.mode.trim().toLowerCase()];
      if (m && m !== step.mode) {
        repairs.push(`${label}: mode "${step.mode}" read as "${m}"`);
        step.mode = m;
      }
    }
    if (typeof step.inputs === "string") step.inputs = [step.inputs];
    if (typeof step.title !== "string" && typeof step.instructions === "string") step.title = step.instructions.slice(0, 60);
    roleFix(step, "role", "do", label);
    roleFix(step, "check", "check", label);
    roleFix(step, "critique", "critique", label);
    if (Array.isArray(step.items) && step.items.length > ctx.limits.maxFanOut) {
      repairs.push(`${label}: kept the first ${ctx.limits.maxFanOut} of ${step.items.length} items`);
      step.items = step.items.slice(0, ctx.limits.maxFanOut);
    }
    if (Array.isArray(step.children)) {
      step.children.forEach((c, i) => isObj(c) && fixStep(c, `${name}.${i + 1}`, inTemplate, owner));
    }
    if (isObj(step.template)) fixStep(step.template, `${name}.template`, true, inTemplate ? owner : name);
  };
  fixStep(plan.root, "root", false);

  // Ids as the tree parser will assign them, to fix duplicates and drop
  // inputs that point nowhere.
  const seen = new Set<string>();
  const all: Obj[] = [];
  const assign = (step: Obj, defaultId: string) => {
    let id = typeof step.id === "string" ? step.id : defaultId;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}-${n}`)) n++;
      repairs.push(`renamed duplicate id "${id}" to "${id}-${n}"`);
      id = `${id}-${n}`;
      step.id = id;
    }
    seen.add(id);
    all.push(step);
    if (Array.isArray(step.children)) step.children.forEach((c, i) => isObj(c) && assign(c, `${id}.${i + 1}`));
  };
  assign(plan.root, "root");
  for (const step of all) {
    if (!Array.isArray(step.inputs)) continue;
    const kept = step.inputs.filter((i) => typeof i === "string" && seen.has(i));
    if (kept.length !== step.inputs.length) {
      repairs.push(`step ${String(step.id ?? "")}: dropped inputs that don't exist (${step.inputs.filter((i) => !kept.includes(i)).join(", ")})`);
      if (kept.length) step.inputs = kept;
      else delete step.inputs;
    }
  }
  return { value: plan, repairs };
}

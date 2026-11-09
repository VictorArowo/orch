import { z } from "zod";
import { findRole, modelsOf, type Job, type Panel } from "./panel.ts";

// The tree format. Hand-written trees and (from milestone 2) the planner both
// produce this shape: a goal and a root step.

export type Mode = "leaf" | "parallel" | "sequence";
export type OutputKind = "text" | "list";

export interface StepSpec {
  id: string;
  title: string;
  mode: Mode;
  instructions: string;
  // Role name from the panel. Leaves without one use the panel's first do role.
  role?: string;
  // Per-step model override for the do role.
  model?: string;
  // Step ids whose outputs this step reads. When omitted, a step in a sequence
  // reads its previous sibling, and anything else inherits its parent's inputs.
  inputs?: string[];
  output: OutputKind;
  check?: string;
  critique?: string;
  maxRetries?: number;
  critiqueRounds?: number;
  maxTokens?: number;
  // Fan-out children carry the item they were made for.
  item?: string;
  children: StepSpec[];
  // Parallel fan-out: one child per item, from a fixed list or from the list
  // output of an earlier step, each made from the template.
  items?: string[];
  itemsFrom?: string;
  template?: StepSpec;
}

export interface Tree {
  version: 1;
  goal: string;
  root: StepSpec;
}

export interface Limits {
  maxDepth: number;
  maxFanOut: number;
  maxSteps: number;
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 4, maxFanOut: 8, maxSteps: 60 };

export class TreeError extends Error {}

interface RawStep {
  id?: string | undefined;
  title?: string | undefined;
  mode?: Mode | undefined;
  instructions?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  inputs?: string[] | undefined;
  output?: OutputKind | undefined;
  check?: string | undefined;
  critique?: string | undefined;
  maxRetries?: number | undefined;
  critiqueRounds?: number | undefined;
  maxTokens?: number | undefined;
  children?: RawStep[] | undefined;
  items?: string[] | undefined;
  itemsFrom?: string | undefined;
  template?: RawStep | undefined;
}

const stepSchema: z.ZodType<RawStep> = z.lazy(() =>
  z
    .object({
      id: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/i, "ids use letters, digits, - and _")
        .optional(),
      title: z.string().optional(),
      mode: z.enum(["leaf", "parallel", "sequence"]).optional(),
      instructions: z.string().optional(),
      role: z.string().optional(),
      model: z.string().optional(),
      inputs: z.array(z.string()).optional(),
      output: z.enum(["text", "list"]).optional(),
      check: z.string().optional(),
      critique: z.string().optional(),
      maxRetries: z.number().int().min(0).max(5).optional(),
      critiqueRounds: z.number().int().min(0).max(3).optional(),
      maxTokens: z.number().int().positive().max(64_000).optional(),
      children: z.array(stepSchema).optional(),
      items: z.array(z.string()).optional(),
      itemsFrom: z.string().optional(),
      template: stepSchema.optional(),
    })
    .strict(),
);

const treeSchema = z
  .object({
    version: z.literal(1).default(1),
    goal: z.string().min(1),
    root: stepSchema,
  })
  .strict();

export function parseTree(input: unknown): Tree {
  const parsed = treeSchema.safeParse(input);
  if (!parsed.success) throw new TreeError(`invalid tree: ${z.prettifyError(parsed.error)}`);
  const root = normalize(parsed.data.root, "root", false);
  return { version: 1, goal: parsed.data.goal, root };
}

function inferMode(raw: RawStep): Mode {
  if (raw.mode) return raw.mode;
  if (raw.items || raw.itemsFrom || raw.template) return "parallel";
  if (raw.children) return "sequence";
  return "leaf";
}

function normalize(raw: RawStep, defaultId: string, inTemplate: boolean): StepSpec {
  if (inTemplate && raw.id) throw new TreeError(`steps inside a template can't set an id (got "${raw.id}")`);
  const id = raw.id ?? defaultId;
  const mode = inferMode(raw);
  const step: StepSpec = {
    id,
    title: raw.title ?? id,
    mode,
    instructions: raw.instructions ?? "",
    output: raw.output ?? "text",
    children: [],
  };
  for (const key of ["role", "model", "check", "critique", "maxRetries", "critiqueRounds", "maxTokens", "inputs"] as const) {
    if (raw[key] !== undefined) (step as unknown as Record<string, unknown>)[key] = raw[key];
  }

  if (mode === "leaf") {
    if (raw.children || raw.items || raw.itemsFrom || raw.template) {
      throw new TreeError(`step "${id}" is a leaf but has children or items`);
    }
    return step;
  }
  if (mode === "sequence") {
    if (raw.items || raw.itemsFrom || raw.template) throw new TreeError(`sequence "${id}" can't fan out; use a parallel step`);
    if (!raw.children?.length) throw new TreeError(`sequence "${id}" has no children`);
    step.children = raw.children.map((c, i) => normalize(c, `${id}.${i + 1}`, inTemplate));
    return step;
  }
  // parallel
  const sources = [raw.children, raw.items, raw.itemsFrom].filter((x) => x !== undefined).length;
  if (sources !== 1) throw new TreeError(`parallel "${id}" needs exactly one of children, items or itemsFrom`);
  if (raw.children) {
    if (!raw.children.length) throw new TreeError(`parallel "${id}" has no children`);
    step.children = raw.children.map((c, i) => normalize(c, `${id}.${i + 1}`, inTemplate));
    return step;
  }
  if (!raw.template) throw new TreeError(`parallel "${id}" fans out over items, so it needs a template`);
  step.template = normalize(raw.template, `${id}.template`, true);
  if (raw.items) {
    step.items = raw.items;
    step.children = expandTemplate(step, raw.items);
  } else {
    step.itemsFrom = raw.itemsFrom!;
  }
  return step;
}

// Make one child per item from a parallel step's template.
export function expandTemplate(parent: StepSpec, items: string[]): StepSpec[] {
  if (!parent.template) throw new TreeError(`step "${parent.id}" has no template`);
  return items.map((item, i) => instantiate(parent.template!, `${parent.id}.${i + 1}`, item));
}

function instantiate(t: StepSpec, id: string, item: string): StepSpec {
  const fill = (s: string) => s.replaceAll("{{item}}", item);
  const out: StepSpec = {
    ...t,
    id,
    title: t.title === t.id ? item : fill(t.title),
    instructions: fill(t.instructions),
    item,
    children: t.children.map((c, j) => instantiate(c, `${id}.${j + 1}`, item)),
  };
  if (t.template) out.template = instantiate(t.template, `${id}.template`, item);
  return out;
}

// Walk a spec tree, including templates (marked so callers can skip them).
export function walk(step: StepSpec, fn: (s: StepSpec, depth: number, inTemplate: boolean) => void, depth = 1, inTemplate = false) {
  fn(step, depth, inTemplate);
  for (const c of step.children) walk(c, fn, depth + 1, inTemplate);
  if (step.template && !step.children.length) walk(step.template, fn, depth + 1, true);
}

// Check limits, ids, inputs and roles against a panel. Returns the models the
// tree can use, so the caller can confirm the gateway knows their prices.
export function validateTree(tree: Tree, panel: Panel, limits: Limits): { models: Set<string> } {
  const ids = new Map<string, StepSpec>();
  let count = 0;
  const models = new Set<string>();

  const roleWithJob = (stepId: string, name: string, job: Job) => {
    const role = findRole(panel, name);
    if (!role) throw new TreeError(`step "${stepId}" uses role "${name}", which isn't in panel "${panel.name}"`);
    if (role.job !== job) throw new TreeError(`step "${stepId}" uses "${name}" as a ${job} role, but its job is ${role.job}`);
    for (const m of modelsOf(role.models)) models.add(m);
  };

  walk(tree.root, (s, depth, inTemplate) => {
    if (depth > limits.maxDepth) throw new TreeError(`step "${s.id}" is at depth ${depth}; the limit is ${limits.maxDepth}`);
    if (!inTemplate) {
      if (ids.has(s.id)) throw new TreeError(`duplicate step id "${s.id}"`);
      ids.set(s.id, s);
      count++;
    }
    if (s.children.length > limits.maxFanOut) {
      throw new TreeError(`step "${s.id}" has ${s.children.length} children; the fan-out limit is ${limits.maxFanOut}`);
    }
    if (s.mode === "leaf") {
      if (s.role) roleWithJob(s.id, s.role, "do");
      else for (const m of modelsOf(panel.roles.find((r) => r.job === "do")!.models)) models.add(m);
      if (s.model) models.add(s.model);
    }
    if (s.check) roleWithJob(s.id, s.check, "check");
    if (s.critique) roleWithJob(s.id, s.critique, "critique");
  });
  if (count > limits.maxSteps) throw new TreeError(`tree has ${count} steps; the limit is ${limits.maxSteps}`);

  // Inputs and itemsFrom must name steps outside the referencing step's own subtree.
  const within = (ancestor: StepSpec, id: string): boolean =>
    ancestor.id === id || ancestor.children.some((c) => within(c, id));
  walk(tree.root, (s) => {
    for (const ref of [...(s.inputs ?? []), ...(s.itemsFrom ? [s.itemsFrom] : [])]) {
      const target = ids.get(ref);
      if (!target) throw new TreeError(`step "${s.id}" reads "${ref}", which doesn't exist`);
      if (within(target, s.id) || within(s, ref)) throw new TreeError(`step "${s.id}" can't read "${ref}": one contains the other`);
    }
    if (s.itemsFrom) {
      const src = ids.get(s.itemsFrom)!;
      if (src.mode !== "leaf" || src.output !== "list") {
        throw new TreeError(`"${s.id}" fans out over "${s.itemsFrom}", which must be a leaf with "output": "list"`);
      }
    }
  });
  return { models };
}

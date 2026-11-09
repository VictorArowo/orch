import type { Panel } from "./panel.js";
import { apply, emptyState, findCycle } from "./state.js";
import { TreeError, validateTree, type Limits, type StepSpec, type Tree } from "./tree.js";

// Everything a tree must pass before it can run: the schema-level checks in
// validateTree, plus a check that no step ends up waiting on itself.
export function checkTree(tree: Tree, panel: Panel, limits: Limits): { models: Set<string> } {
  const result = validateTree(tree, panel, limits);
  const probe = apply(emptyState("check"), {
    type: "run.created",
    goal: tree.goal,
    root: tree.root,
    panel,
    cap: 0,
    limits,
    concurrency: 1,
    gateway: "",
    runId: "check",
    seq: 1,
    at: new Date(0).toISOString(),
  });
  const cycle = findCycle(probe);
  if (cycle) throw new TreeError(`steps wait on each other in a loop: ${cycle.join(" → ")}`);
  return result;
}

// The tree as an editable file: defaults left out, fan-outs kept as their
// items and template rather than the expanded children.
export function treeToJson(tree: Tree): unknown {
  return { version: 1, goal: tree.goal, root: compact(tree.root, undefined) };
}

function compact(s: StepSpec, defaultId: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (defaultId === undefined || s.id !== defaultId) out.id = s.id;
  if (s.title !== s.id) out.title = s.title;
  out.mode = s.mode;
  for (const key of ["role", "model", "inputs"] as const) if (s[key] !== undefined) out[key] = s[key];
  if (s.output !== "text") out.output = s.output;
  for (const key of ["check", "critique", "maxRetries", "critiqueRounds", "maxTokens"] as const) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (s.instructions) out.instructions = s.instructions;
  if (s.template) {
    if (s.items) out.items = s.items;
    if (s.itemsFrom) out.itemsFrom = s.itemsFrom;
    const t = compact(s.template, s.template.id);
    delete t.id;
    out.template = t;
  } else if (s.children.length) {
    out.children = s.children.map((c, i) => compact(c, `${s.id}.${i + 1}`));
  }
  return out;
}

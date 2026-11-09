import { treeToJson } from "../core/check-tree.ts";
import { parseTree, type StepSpec, type Tree } from "../core/tree.ts";
import { stackId } from "./view.ts";

// Edits the tree editor makes. Each one works on a copy and goes back through
// the file format and the parser, so the result is always a well-formed tree
// (or the edit throws and nothing changes).

export type StepPatch = Partial<Pick<StepSpec, "title" | "instructions" | "role" | "model" | "inputs" | "output" | "check" | "critique" | "maxRetries" | "items" | "itemsFrom">> & {
  mode?: "sequence" | "parallel";
};

interface Found {
  step: StepSpec;
  parent?: StepSpec;
  // Set when the step is a fan-out's template.
  templateOf?: StepSpec;
}

export function findStep(root: StepSpec, id: string): Found | undefined {
  if (root.id === id) return { step: root };
  if (root.template && stackId(root.id) === id) return { step: root.template, templateOf: root };
  for (const c of root.children) {
    if (c.id === id) return { step: c, parent: root };
    const found = findStep(c, id);
    if (found) return found;
  }
  return undefined;
}

function clone(tree: Tree): Tree {
  return structuredClone(tree);
}

function reparse(tree: Tree): Tree {
  // Fan-outs keep their template and drop the expanded copies, so edits to
  // the template reach every branch.
  return parseTree(treeToJson(tree));
}

function must(tree: Tree, id: string): Found {
  const f = findStep(tree.root, id);
  if (!f) throw new Error(`no step "${id}"`);
  return f;
}

export function updateStep(tree: Tree, id: string, patch: StepPatch): Tree {
  const next = clone(tree);
  const { step } = must(next, id);
  const target = step as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length && k !== "items")) delete target[k];
    else target[k] = v;
  }
  if (patch.itemsFrom !== undefined && patch.itemsFrom) delete step.items;
  if (patch.items !== undefined && patch.items.length) delete step.itemsFrom;
  return reparse(next);
}

export function setGoal(tree: Tree, goal: string): Tree {
  return reparse({ ...clone(tree), goal });
}

function freshId(tree: Tree, base: string): string {
  const taken = new Set<string>();
  const visit = (s: StepSpec) => {
    taken.add(s.id);
    s.children.forEach(visit);
  };
  visit(tree.root);
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Add a leaf at the end of a sequence or parallel step with explicit children.
export function addChild(tree: Tree, parentId: string): { tree: Tree; id: string } {
  const next = clone(tree);
  const { step } = must(next, parentId);
  if (step.mode === "leaf" || step.template) throw new Error("steps can only be added to a sequence or a parallel step with its own children");
  const id = freshId(next, "step");
  step.children.push({ id, title: "New step", mode: "leaf", instructions: "", output: "text", children: [] });
  return { tree: reparse(next), id };
}

export function removeStep(tree: Tree, id: string): Tree {
  const next = clone(tree);
  const { parent } = must(next, id);
  if (!parent) throw new Error("the root step can't be removed");
  if (parent.children.length === 1) throw new Error(`"${parent.title}" needs at least one step`);
  parent.children = parent.children.filter((c) => c.id !== id);
  return reparse(next);
}

export function moveStep(tree: Tree, id: string, by: -1 | 1): Tree {
  const next = clone(tree);
  const { parent } = must(next, id);
  if (!parent) return tree;
  const i = parent.children.findIndex((c) => c.id === id);
  const j = i + by;
  if (j < 0 || j >= parent.children.length) return tree;
  [parent.children[i], parent.children[j]] = [parent.children[j]!, parent.children[i]!];
  return reparse(next);
}

// Leaves that return a list another step can fan out over.
export function listSteps(tree: Tree): StepSpec[] {
  const out: StepSpec[] = [];
  const visit = (s: StepSpec) => {
    if (s.mode === "leaf" && s.output === "list") out.push(s);
    s.children.forEach(visit);
  };
  visit(tree.root);
  return out;
}

export function allSteps(tree: Tree): StepSpec[] {
  const out: StepSpec[] = [];
  const visit = (s: StepSpec) => {
    out.push(s);
    s.children.forEach(visit);
  };
  visit(tree.root);
  return out;
}

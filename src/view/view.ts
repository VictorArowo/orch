import { isLeaf, type RunState } from "../core/state.ts";
import type { StepSpec } from "../core/tree.ts";

// What the canvas draws: leaves as cards, sequence and parallel steps as boxes
// around their children, and a fan-out whose branches don't exist yet (or, in
// the editor, any fan-out) as one stacked card standing for its template.

export type ViewKind = "leaf" | "group" | "stack";

export interface ViewNode {
  id: string;
  kind: ViewKind;
  spec: StepSpec;
  children: ViewNode[];
  // For a stack: the fan-out step it belongs to.
  ownerId?: string;
}

export function stackId(ownerId: string): string {
  return `${ownerId}.template`;
}

// The editor's view of a tree. Fan-outs show their template, since that is
// what you edit; the branches are made from it at run time.
export function viewOfSpec(spec: StepSpec): ViewNode {
  if (spec.mode === "leaf") return { id: spec.id, kind: "leaf", spec, children: [] };
  if (spec.template) {
    const stack: ViewNode = { id: stackId(spec.id), kind: "stack", spec: spec.template, children: [], ownerId: spec.id };
    return { id: spec.id, kind: "group", spec, children: [stack] };
  }
  return { id: spec.id, kind: "group", spec, children: spec.children.map(viewOfSpec) };
}

// A run's view: real branches once a fan-out has expanded.
export function viewOfRun(state: RunState, id = state.rootId): ViewNode {
  const step = state.steps[id]!;
  if (isLeaf(step)) return { id, kind: "leaf", spec: step.spec, children: [] };
  if (!step.expanded) {
    const stack: ViewNode = { id: stackId(id), kind: "stack", spec: step.spec.template!, children: [], ownerId: id };
    return { id, kind: "group", spec: step.spec, children: [stack] };
  }
  return { id, kind: "group", spec: step.spec, children: step.childIds.map((c) => viewOfRun(state, c)) };
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: "next" | "reads" | "items";
}

// Arrows between consecutive steps of a sequence, dashed lines for inputs
// that aren't simply the previous step, and for where a fan-out gets its list.
export function edgesOf(root: ViewNode): ViewEdge[] {
  const edges: ViewEdge[] = [];
  const present = new Set<string>();
  const parentOf = new Map<string, ViewNode>();
  const visit = (n: ViewNode) => {
    present.add(n.id);
    for (const c of n.children) {
      parentOf.set(c.id, n);
      visit(c);
    }
  };
  visit(root);

  const walk = (n: ViewNode) => {
    if (n.kind === "group" && n.spec.mode === "sequence") {
      n.children.forEach((c, i) => {
        const next = n.children[i + 1];
        if (next) edges.push({ id: `next:${c.id}>${next.id}`, source: c.id, target: next.id, kind: "next" });
      });
    }
    if (n.kind === "group" && n.spec.itemsFrom && present.has(n.spec.itemsFrom)) {
      edges.push({ id: `items:${n.spec.itemsFrom}>${n.id}`, source: n.spec.itemsFrom, target: n.id, kind: "items" });
    }
    const parent = parentOf.get(n.id);
    const prev = parent && parent.spec.mode === "sequence" ? parent.children[parent.children.indexOf(n) - 1]?.id : undefined;
    for (const input of n.spec.inputs ?? []) {
      if (input === prev || !present.has(input)) continue;
      edges.push({ id: `reads:${input}>${n.id}`, source: input, target: n.id, kind: "reads" });
    }
    n.children.forEach(walk);
  };
  walk(root);
  return edges;
}

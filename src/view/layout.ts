import type { ViewNode } from "./view.ts";

// A step tree is series-parallel, so it lays out without a graph-layout
// library: a sequence stacks its children top to bottom, a parallel step puts
// them side by side, and each box is sized from its contents.

export const SIZES = {
  leafW: 248,
  leafH: 128,
  header: 34,
  pad: 14,
  seqGap: 40,
  parGap: 18,
  // Boxes are at least this wide, so their title and estimate fit.
  boxMinW: 320,
};

export interface Placed {
  id: string;
  kind: ViewNode["kind"];
  // Relative to the parent box, as React Flow expects for child nodes.
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  depth: number;
}

interface Size {
  w: number;
  h: number;
}

// Measure every box, and work out where each child sits inside its parent.
// A sequence stacks its children, centred. A parallel step lays them out in
// rows of at most `maxCols`, so a wide fan-out stays readable.
function measure(n: ViewNode, sizes: Map<string, Size>, offsets: Map<string, { x: number; y: number }>, maxCols: number): Size {
  let s: Size;
  if (n.kind !== "group") {
    s = { w: SIZES.leafW, h: SIZES.leafH };
  } else {
    const kids = n.children.map((c) => ({ id: c.id, ...measure(c, sizes, offsets, maxCols) }));
    const top = SIZES.header + SIZES.pad;
    if (n.spec.mode === "sequence") {
      const innerW = Math.max(SIZES.boxMinW - 2 * SIZES.pad, ...kids.map((k) => k.w));
      let y = top;
      for (const k of kids) {
        offsets.set(k.id, { x: SIZES.pad + (innerW - k.w) / 2, y });
        y += k.h + SIZES.seqGap;
      }
      s = { w: innerW + 2 * SIZES.pad, h: y - SIZES.seqGap + SIZES.pad };
    } else {
      const rows: (typeof kids)[] = [];
      for (let i = 0; i < kids.length; i += maxCols) rows.push(kids.slice(i, i + maxCols));
      const rowW = (row: typeof kids) => row.reduce((a, k) => a + k.w, 0) + SIZES.parGap * (row.length - 1);
      const innerW = Math.max(SIZES.boxMinW - 2 * SIZES.pad, ...rows.map(rowW));
      let y = top;
      for (const row of rows) {
        let x = SIZES.pad + (innerW - rowW(row)) / 2;
        for (const k of row) {
          offsets.set(k.id, { x, y });
          x += k.w + SIZES.parGap;
        }
        y += Math.max(...row.map((k) => k.h)) + SIZES.parGap;
      }
      s = { w: innerW + 2 * SIZES.pad, h: y - SIZES.parGap + SIZES.pad };
    }
  }
  sizes.set(n.id, s);
  return s;
}

// Parents come before their children, which React Flow requires.
export function layout(root: ViewNode, opts: { maxCols?: number } = {}): { nodes: Placed[]; width: number; height: number } {
  const sizes = new Map<string, Size>();
  const offsets = new Map<string, { x: number; y: number }>();
  const total = measure(root, sizes, offsets, opts.maxCols ?? 3);
  const nodes: Placed[] = [];
  const place = (n: ViewNode, x: number, y: number, parentId: string | undefined, depth: number) => {
    const s = sizes.get(n.id)!;
    const p: Placed = { id: n.id, kind: n.kind, x, y, w: s.w, h: s.h, depth };
    if (parentId !== undefined) p.parentId = parentId;
    nodes.push(p);
    for (const c of n.children) {
      const o = offsets.get(c.id)!;
      place(c, o.x, o.y, n.id, depth + 1);
    }
  };
  place(root, 0, 0, undefined, 0);
  return { nodes, width: total.w, height: total.h };
}

"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { layout } from "orch/src/view/layout.ts";
import { edgesOf, type ViewNode } from "orch/src/view/view.ts";
import { useEffect, useMemo, useRef } from "react";

export type Tone = "role" | "dim" | "faint" | "run" | "done" | "fail" | "blocked" | "stale" | "ink";
export type CardStatus = "idle" | "pending" | "running" | "blocked" | "done" | "failed";

export interface CardInfo {
  title: string;
  status: CardStatus;
  // Short lines under the title, such as the role and model.
  lines: { text: string; tone?: Tone }[];
  tags: { text: string; tone?: Tone }[];
  // Cost or estimate, top right.
  amount?: string;
  // For a fan-out template: how many branches it stands for.
  count?: string;
  // For boxes: "sequence 2/4" and the like.
  mode?: string;
}

const TONE: Record<Tone, string> = {
  role: "text-blue",
  dim: "text-ink-soft",
  faint: "text-graphite",
  run: "text-ink font-medium",
  done: "text-ink",
  fail: "text-red note",
  blocked: "text-red note",
  stale: "text-blue note",
  ink: "text-ink",
};

// How a step is drawn says where it is: pencilled in, highlighted while it
// plays, inked when done, marked in red when something went wrong.
const SHEET: Record<CardStatus, string> = {
  idle: "bg-sheet border-ink/25",
  pending: "bg-paper border-dashed border-graphite-light",
  running: "highlighting border-ink",
  blocked: "bg-sheet border-dashed border-red",
  done: "bg-sheet border-ink border-[1.5px]",
  failed: "bg-sheet border-red border-[1.5px]",
};

const TITLE: Record<CardStatus, string> = {
  idle: "text-ink",
  pending: "text-graphite",
  running: "text-ink",
  blocked: "text-ink",
  done: "text-ink",
  failed: "text-ink",
};

const MARK: Partial<Record<CardStatus, [string, string]>> = {
  done: ["✓", "text-ink"],
  failed: ["✗", "text-red"],
  blocked: ["$", "text-red"],
  running: ["●", "text-ink animate-pulse"],
};

type Data = { info?: CardInfo; selected: boolean; w: number; h: number };

const hidden = "!h-1 !w-1 !min-w-0 !border-0 !bg-transparent";

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} className={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className={hidden} isConnectable={false} />
      {/* Inputs and fan-out lists route around the right-hand side, clear of the cards. */}
      <Handle id="side-in" type="target" position={Position.Right} className={hidden} isConnectable={false} />
      <Handle id="side-out" type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </>
  );
}

const selectedRing = "outline outline-2 outline-offset-[3px] outline-blue";

function Card({ data, stacked }: { data: Data; stacked?: boolean }) {
  const info = data.info;
  const status = info?.status ?? "idle";
  const mark = MARK[status];
  return (
    <div style={{ width: data.w, height: data.h }} className="relative">
      {stacked && (
        <>
          <div className="absolute inset-0 translate-x-[10px] translate-y-[10px] rounded-[6px] border border-rule bg-sheet" />
          <div className="absolute inset-0 translate-x-[5px] translate-y-[5px] rounded-[6px] border border-rule bg-sheet" />
        </>
      )}
      <div className={`relative flex h-full flex-col overflow-hidden rounded-[6px] border px-3.5 pt-3 pb-2.5 text-left ${SHEET[status]} ${data.selected ? selectedRing : ""}`}>
        <div className="flex items-start gap-2">
          <div className={`line-clamp-2 min-w-0 flex-1 text-[14px] font-semibold leading-[1.25] ${TITLE[status]}`}>{info?.title}</div>
          {mark && <span className={`shrink-0 text-[13px] leading-[1.35] ${mark[1]}`}>{mark[0]}</span>}
        </div>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {info?.lines.map((l, i) => (
            <div key={i} className={`truncate text-[12.5px] leading-snug ${TONE[l.tone ?? "dim"]}`}>
              {l.text}
            </div>
          ))}
        </div>
        <div className="mt-auto flex items-end gap-2 pt-1">
          {/* One line; anything that doesn't fit is in the side panel. */}
          <div className="min-w-0 flex-1 truncate text-[12px] leading-snug" title={info?.tags.map((t) => t.text).join(", ")}>
            {info?.count && <span className="mr-2.5 font-semibold text-ink">{info.count}</span>}
            {info?.tags.map((t, i) => (
              <span key={i} className={`mr-2.5 ${TONE[t.tone ?? "faint"]}`}>
                {t.text}
              </span>
            ))}
          </div>
          {info?.amount && <div className="tnum shrink-0 text-[12px] text-ink-soft">{info.amount}</div>}
        </div>
      </div>
      <Handles />
    </div>
  );
}

function CardNode({ data }: NodeProps<Node<Data>>) {
  return <Card data={data} />;
}

function StackNode({ data }: NodeProps<Node<Data>>) {
  return <Card data={data} stacked />;
}

// Steps that run together are joined by a bracket, as parts that play
// together are in a score. A sequence gets a plain rule.
function BoxNode({ data }: NodeProps<Node<Data>>) {
  const info = data.info;
  const status = info?.status ?? "idle";
  const together = info?.mode?.startsWith("together") || info?.mode?.startsWith("for each");
  const color = status === "running" ? "border-highlight-deep" : status === "pending" ? "border-graphite-light" : status === "failed" ? "border-red" : "border-ink";
  return (
    <div style={{ width: data.w, height: data.h }} className={`relative rounded-[6px] ${data.selected ? selectedRing : ""}`}>
      <div className="flex h-[34px] items-baseline gap-2 pl-4 pr-1 pt-2">
        <span className={`min-w-0 truncate text-[13px] font-semibold ${status === "pending" ? "text-graphite" : "text-ink"}`}>{info?.title}</span>
        {info?.mode && <span className="note min-w-0 shrink truncate text-[12px] text-graphite">{info.mode}</span>}
        {info?.amount && <span className="tnum ml-auto shrink-0 pl-2 text-[12px] text-ink-soft">{info.amount}</span>}
      </div>
      {together ? (
        <div className={`absolute bottom-1 left-0 top-[36px] w-2 rounded-l-[3px] border-y-[3px] border-l-[3px] ${color}`} />
      ) : (
        <div className={`absolute bottom-1 left-[3px] top-[36px] border-l ${color}`} />
      )}
      <Handles />
    </div>
  );
}

const nodeTypes = { card: CardNode, stack: StackNode, box: BoxNode };

export interface CanvasProps {
  root: ViewNode;
  info: Record<string, CardInfo>;
  selected?: string | undefined;
  onSelect: (id: string | undefined) => void;
  // Steps that are working right now; edges into them are animated.
  active?: Set<string>;
  // A picture rather than a tool: no panning, zooming or controls.
  still?: boolean;
}

function Inner({ root, info, selected, onSelect, active, still }: CanvasProps) {
  const { fitView } = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  // Refit when the canvas itself changes size: the side panel being dragged,
  // or the header above growing once its content loads.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => void fitView({ padding: 0.12 }), 60);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [fitView]);
  const placed = useMemo(() => layout(root), [root]);
  const shape = placed.nodes.map((n) => n.id).join("|");

  const nodes: Node<Data>[] = useMemo(
    () =>
      placed.nodes.map((p) => {
        const node: Node<Data> = {
          id: p.id,
          type: p.kind === "group" ? "box" : p.kind === "stack" ? "stack" : "card",
          position: { x: p.x, y: p.y },
          data: { info: info[p.id], selected: selected === p.id, w: p.w, h: p.h },
          style: { width: p.w, height: p.h },
          draggable: false,
          connectable: false,
          zIndex: p.depth,
        };
        if (p.parentId) node.parentId = p.parentId;
        return node;
      }),
    [placed, info, selected],
  );

  const edges: Edge[] = useMemo(
    () =>
      edgesOf(root).map((e) => {
        const live = active?.has(e.target) ?? false;
        const edge: Edge = {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          zIndex: 1000,
          animated: live,
          style: {
            stroke: live ? "var(--color-highlight-deep)" : e.kind === "next" ? "var(--color-ink-soft)" : "var(--color-blue)",
            strokeWidth: live ? 2 : e.kind === "next" ? 1.25 : 1,
            strokeDasharray: e.kind === "next" ? undefined : "2 4",
            opacity: e.kind === "next" || live ? 1 : 0.7,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: live ? "var(--color-highlight-deep)" : e.kind === "next" ? "var(--color-ink-soft)" : "var(--color-blue)" },
        };
        if (e.kind !== "next") {
          edge.label = e.kind === "items" ? "items" : "reads";
          edge.sourceHandle = "side-out";
          edge.targetHandle = "side-in";
          (edge as Edge & { pathOptions: { offset: number; borderRadius: number } }).pathOptions = { offset: 28, borderRadius: 10 };
        }
        return edge;
      }),
    [root, active],
  );



  return (
    <div ref={box} className="h-full w-full">
    {/* A new shape (a fan-out expanding, a step added) remounts the canvas, so
        React Flow fits the whole tree once it has measured the new nodes. */}
    <ReactFlow
      key={shape}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(undefined)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.15}
      maxZoom={1.6}
      panOnDrag={!still}
      zoomOnScroll={!still}
      zoomOnPinch={!still}
      zoomOnDoubleClick={!still}
      preventScrolling={!still}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      colorMode="light"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#d3d6d0" />
      {!still && <Controls showInteractive={false} position="bottom-left" />}
    </ReactFlow>
    </div>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

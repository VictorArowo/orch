"use client";

import Link from "next/link";
import { parseTree } from "orch/src/core/tree.ts";
import { viewOfSpec } from "orch/src/view/view.ts";
import { useMemo } from "react";
import { Canvas, type CardInfo } from "./Canvas";

// A run caught mid-performance: the first steps inked, two research branches
// highlighted as they play, the rest still pencilled in.
const SAMPLE = parseTree({
  goal: "Compare the five most popular open-source vector databases for a small startup.",
  root: {
    id: "root",
    title: "Compare vector databases",
    children: [
      { id: "pick", title: "Pick the five databases", role: "researcher", output: "list" },
      {
        id: "research",
        title: "Research each database",
        mode: "parallel",
        children: ["Qdrant", "Weaviate", "Milvus", "Chroma", "pgvector"].map((name, i) => ({ id: `r${i}`, title: `Research ${name}`, role: "researcher" })),
      },
      { id: "compare", title: "Compare them side by side", role: "analyst", inputs: ["research"] },
      { id: "recommend", title: "Write the recommendation", role: "writer", inputs: ["compare", "research"] },
    ],
  },
});

const CARDS: Record<string, CardInfo> = {
  root: { title: "Compare vector databases", status: "running", lines: [], tags: [], mode: "in order, 1 of 4 done", amount: "$0.0061" },
  pick: { title: "Pick the five databases", status: "done", lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash" }], tags: [], amount: "$0.00002" },
  research: { title: "Research each database", status: "running", lines: [], tags: [], mode: "together, 3 of 5 done", amount: "$0.0061" },
  r0: { title: "Research Qdrant", status: "done", lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash" }], tags: [], amount: "$0.0011" },
  r1: {
    title: "Research Weaviate",
    status: "done",
    lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash → gemini-3.8-flash" }],
    tags: [{ text: "sent back 1×", tone: "fail" }],
    amount: "$0.0031",
  },
  r2: { title: "Research Milvus", status: "running", lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash" }], tags: [{ text: "checking 4s", tone: "run" }], amount: "$0.0009" },
  r3: { title: "Research Chroma", status: "done", lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash" }], tags: [], amount: "$0.0010" },
  r4: { title: "Research pgvector", status: "running", lines: [{ text: "researcher", tone: "role" }, { text: "deepseek-v4.1-flash" }], tags: [{ text: "working 7s", tone: "run" }] },
  compare: { title: "Compare them side by side", status: "pending", lines: [{ text: "analyst", tone: "role" }, { text: "not started", tone: "faint" }], tags: [] },
  recommend: { title: "Write the recommendation", status: "pending", lines: [{ text: "writer", tone: "role" }, { text: "not started", tone: "faint" }], tags: [{ text: "critique by critic", tone: "faint" }] },
};

export function Landing() {
  const view = useMemo(() => viewOfSpec(SAMPLE.root), []);
  const active = useMemo(() => new Set(["r2", "r4"]), []);
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 pt-14 pb-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col">
          <h1 className="text-[48px] font-bold leading-[1.02] tracking-[-0.03em]">Give it a goal. Watch the plan play out.</h1>
          <p className="mt-6 max-w-lg text-[18px] leading-relaxed text-ink-soft">
            orch drafts a plan as a tree of steps. You choose which model plays each part, who checks the work and what it may spend, then watch the steps run,
            get checked, get sent back and finish.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/signup" className="inline-flex h-11 items-center rounded-[5px] bg-ink px-5 text-[15px] font-medium text-paper hover:bg-ink-soft">
              Create an account
            </Link>
            <Link href="/signin" className="text-[15px] text-ink-soft underline-offset-4 hover:text-ink hover:underline">
              Sign in
            </Link>
          </div>
          <dl className="mt-12 flex max-w-lg flex-col gap-5 text-[15px] leading-relaxed">
            <div>
              <dt className="font-semibold">Your cast, any model.</dt>
              <dd className="text-ink-soft">Roles are yours to define, and each can use any model on OpenRouter: a cheap one that steps up when its work is sent back, or a jury of three.</dd>
            </div>
            <div>
              <dt className="font-semibold">Spend you can see and cap.</dt>
              <dd className="text-ink-soft">An estimate before you start, money spent as it happens, and a hard limit. You use your own key, so OpenRouter bills you directly.</dd>
            </div>
            <div>
              <dt className="font-semibold">Everything on the record.</dt>
              <dd className="text-ink-soft">Every step shows what it was told, what it did, who reviewed it and what it cost.</dd>
            </div>
          </dl>
        </div>
        <div className="h-[620px] overflow-hidden rounded-[8px] border border-rule" aria-label="A run in progress: two research steps are working while the rest wait" role="img">
          <Canvas root={view} info={CARDS} onSelect={() => {}} active={active} still />
        </div>
      </div>
    </div>
  );
}

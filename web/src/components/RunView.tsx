"use client";

import type { RunEvent } from "orch/src/core/events.ts";
import { formatUsd } from "orch/src/core/money.ts";
import { apply, emptyState, isLeaf, isStale, stepCost, stepStatus, type RunState, type StepState } from "orch/src/core/state.ts";
import { viewOfRun, type ViewNode } from "orch/src/view/view.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type CardInfo, type CardStatus } from "./Canvas";
import { RunInspector } from "./RunInspector";
import { Button, ErrorNote, inputClass, shortModel, Status } from "./ui";
import { post } from "@/lib/api";

const ACTIVITY = { do: "working", check: "checking", critique: "critiquing" } as const;

function elapsed(fromIso: string | undefined, now: number): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function modelsUsed(state: RunState, step: StepState): string[] {
  const out: string[] = [];
  for (const a of step.attemptIds) {
    const m = shortModel(state.attempts[a]!.model);
    if (out[out.length - 1] !== m) out.push(m);
  }
  return out;
}

function leafCard(state: RunState, step: StepState, started: Map<string, string>, now: number): CardInfo {
  const status = stepStatus(state, step.id) as CardStatus;
  const attempts = step.attemptIds.map((a) => state.attempts[a]!);
  const last = attempts[attempts.length - 1];
  const role = last?.role ?? step.spec.role ?? state.panel.roles.find((r) => r.job === "do")?.name ?? "";
  const models = modelsUsed(state, step);
  const tags: CardInfo["tags"] = [];
  const open = last?.callIds.map((c) => state.calls[c]!).find((c) => c.status === "open");
  if (open) tags.push({ text: `${ACTIVITY[open.purpose]} ${elapsed(started.get(step.id), now)}`, tone: "run" });
  if (attempts.length > 1) tags.push({ text: `${attempts.length} attempts`, tone: "dim" });
  const sentBack = attempts.filter((a) => a.rejected?.reason === "check").length;
  if (sentBack) tags.push({ text: `sent back ${sentBack}×`, tone: "faint" });
  if (attempts.some((a) => a.rejected?.reason === "critique")) tags.push({ text: "revised after critique", tone: "faint" });
  for (const r of attempts.flatMap((a) => a.reviews)) {
    const revise = r.votes.filter((v) => v.verdict === "revise").length;
    if (r.votes.length > 1 && revise && revise < r.votes.length) tags.push({ text: `jury split ${r.votes.length - revise}-${revise}`, tone: "faint" });
  }
  if (step.warning) tags.push({ text: "check unresolved", tone: "run" });
  if (step.blocked) tags.push({ text: `needs ${formatUsd(step.blocked.neededNanos)}`, tone: "blocked" });
  if (status === "done" && isStale(state, step.id)) tags.push({ text: "stale", tone: "stale" });
  if (step.error) tags.push({ text: step.error, tone: "fail" });
  const cost = stepCost(state, step.id);
  const card: CardInfo = {
    title: step.spec.title,
    status,
    lines: [
      { text: role, tone: "role" },
      { text: models.join(" → ") || "not started", tone: models.length ? "dim" : "faint" },
    ],
    tags,
  };
  if (cost) card.amount = formatUsd(cost);
  return card;
}

function cardsFor(state: RunState, view: ViewNode, started: Map<string, string>, now: number): Record<string, CardInfo> {
  const out: Record<string, CardInfo> = {};
  const visit = (n: ViewNode) => {
    if (n.kind === "leaf") out[n.id] = leafCard(state, state.steps[n.id]!, started, now);
    else if (n.kind === "stack") {
      const owner = state.steps[n.ownerId!]!;
      out[n.id] = {
        title: n.spec.title,
        status: "pending",
        lines: [{ text: n.spec.role ?? "", tone: "role" }],
        tags: [{ text: `waits for ${owner.spec.itemsFrom}`, tone: "faint" }],
        count: "×each",
      };
    } else {
      const step = state.steps[n.id]!;
      const kids = step.childIds;
      const done = kids.filter((k) => stepStatus(state, k) === "done").length;
      const card: CardInfo = {
        title: step.spec.title,
        status: stepStatus(state, n.id) as CardStatus,
        lines: [],
        tags: [],
        mode: !step.expanded
          ? `for each from ${step.spec.itemsFrom}`
          : `${step.spec.mode === "sequence" ? "in order" : "together"}, ${done} of ${kids.length} done`,
      };
      const cost = stepCost(state, n.id);
      if (cost) card.amount = formatUsd(cost);
      out[n.id] = card;
    }
    n.children.forEach(visit);
  };
  visit(view);
  return out;
}

export function RunView({ runId }: { runId: string }) {
  const stateRef = useRef<RunState>(emptyState(runId));
  const started = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);

  // Follow the run's events and fold them with the engine's own reducer.
  useEffect(() => {
    const state = (stateRef.current = emptyState(runId));
    started.current = new Map();
    let frame = 0;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent;
      if (e.seq <= state.lastSeq) return;
      apply(state, e);
      if (e.type === "attempt.started") started.current.set(e.stepId, e.at);
      if (e.type === "call.reserved") started.current.set(e.stepId, e.at);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((v) => v + 1);
      });
    };
    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  const state = stateRef.current;
  const running = state.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (state.cap && !cap) setCap((state.cap / 1e9).toFixed(2));
  }, [version, state.cap, cap]);

  const shape = state.lastSeq ? state.order.join("|") + Object.values(state.steps).map((s) => (s.expanded ? 1 : 0)).join("") : "";
  const view = useMemo(() => (state.rootId ? viewOfRun(state) : undefined), [shape]);
  const cards = useMemo(() => (view ? cardsFor(state, view, started.current, now) : {}), [view, version, now]);
  const active = useMemo(() => {
    const ids = new Set<string>();
    for (const s of Object.values(state.steps)) if (isLeaf(s) && stepStatus(state, s.id) === "running") ids.add(s.id);
    return ids;
  }, [version]);

  async function control(action: "pause" | "resume") {
    setBusy(true);
    setError(undefined);
    try {
      await post(`/api/runs/${runId}/${action}`, action === "resume" ? { capUsd: Number(cap) } : {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return <div className="note p-10 text-[14px] text-graphite">{connected ? "Loading the run…" : "Connecting to the engine…"}</div>;
  }

  const spent = state.spentNanos;
  const reserved = state.reservedNanos;
  const pct = (n: number) => `${Math.min(100, (n / Math.max(1, state.cap)) * 100)}%`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2.5 px-5 pt-4 pb-3">
        <div className="flex items-baseline gap-4">
          <h1 className="min-w-0 flex-1 truncate text-[22px] font-bold tracking-[-0.01em]">{state.goal}</h1>
          {!connected && <span className="note text-[13px] text-red">Reconnecting…</span>}
          <Status status={state.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-ink-soft">
          <div className="flex items-center gap-3">
            <div className="relative h-[6px] w-56 rounded-full bg-rule" aria-hidden>
              <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: pct(spent) }} />
              <div className="absolute inset-y-0 rounded-full bg-highlight" style={{ left: pct(spent), width: pct(reserved) }} />
            </div>
            <span className="tnum">
              <span className="font-semibold text-ink">{formatUsd(spent)}</span> of {formatUsd(state.cap)}
              {reserved ? <span className="note text-graphite"> ({formatUsd(reserved)} held for calls in flight)</span> : null}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {running && (
              <Button onClick={() => void control("pause")} disabled={busy}>
                Pause
              </Button>
            )}
            {(state.status === "paused" || state.status === "stopped") && (
              <>
                <label className="flex items-center gap-1.5">
                  Spend at most $
                  <input className={`${inputClass} tnum w-[72px] py-1`} value={cap} inputMode="decimal" onChange={(e) => setCap(e.target.value)} aria-label="Spending cap in dollars" />
                </label>
                <Button tone="primary" onClick={() => void control("resume")} disabled={busy || !(Number(cap) > 0)}>
                  Resume
                </Button>
              </>
            )}
          </div>
        </div>
        {(state.reason || error) && (
          <div className="flex flex-col gap-1.5 text-[13px]">
            {state.reason && (
              <span className="note text-red">
                {state.status === "paused" ? "Paused" : "Stopped"}: {state.reason}
                {state.neededNanos ? `. The next call needs up to ${formatUsd(state.neededNanos)} and ${formatUsd(Math.max(0, state.cap - spent))} is left; raise the limit to carry on.` : "."}
              </span>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-t border-rule">
          <Canvas root={view} info={cards} selected={selected} onSelect={setSelected} active={active} />
        </div>
        <aside className="scroll-thin w-[420px] shrink-0 overflow-y-auto border-t border-l border-rule bg-sheet px-5 py-5">
          <RunInspector state={state} selected={selected} version={version} />
        </aside>
      </div>
    </div>
  );
}

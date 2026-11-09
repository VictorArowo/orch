"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { treeToJson } from "orch/src/core/check-tree.ts";
import type { TreeEstimate } from "orch/src/core/estimate.ts";
import type { Drafted } from "orch/src/core/events.ts";
import { formatUsd } from "orch/src/core/money.ts";
import { defaultDoRole, findRole, modelsOf, type Panel } from "orch/src/core/panel.ts";
import { parseTree, type StepSpec, type Tree } from "orch/src/core/tree.ts";
import { addChild, moveStep, removeStep, setGoal, updateStep, type StepPatch } from "orch/src/view/edit.ts";
import { viewOfSpec, type ViewNode } from "orch/src/view/view.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type CardInfo } from "./Canvas";
import { PanelNote } from "./PanelNote";
import { StepForm } from "./StepForm";
import { Button, ErrorNote, inputClass, shortModel } from "./ui";
import { get, post, type CheckResponse, type PanelEntry } from "@/lib/api";
import { loadDraft } from "@/lib/draft";
import { useMe } from "@/lib/session";

function range(e?: { low: number; high: number }): string | undefined {
  return e ? `${formatUsd(e.low)}–${formatUsd(e.high)}` : undefined;
}

// A tidy cap suggestion: the high estimate rounded up.
function suggestCap(high: number): string {
  const usd = high / 1e9;
  return ([0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10].find((s) => s >= usd) ?? Math.ceil(usd)).toFixed(2);
}

function cardsFor(view: ViewNode, panel: Panel, estimate: TreeEstimate | undefined, badStep: string | undefined): Record<string, CardInfo> {
  const out: Record<string, CardInfo> = {};
  const leafCard = (spec: StepSpec, id: string): CardInfo => {
    const role = spec.role ? findRole(panel, spec.role) : defaultDoRole(panel);
    const models = spec.model ? shortModel(spec.model) : role ? modelsOf(role.models).map(shortModel).join(" → ") : "?";
    const tags: CardInfo["tags"] = [];
    if (spec.output === "list") tags.push({ text: "returns a list", tone: "dim" });
    if (spec.check) tags.push({ text: `check ${spec.check}`, tone: "faint" });
    if (spec.critique) tags.push({ text: `critique ${spec.critique}`, tone: "faint" });
    return {
      title: spec.title,
      status: badStep === id ? "failed" : "idle",
      lines: [{ text: role?.name ?? `no role "${spec.role}"`, tone: role ? "role" : "fail" }, { text: models, tone: "dim" }],
      tags,
      ...(range(estimate?.steps[id]) ? { amount: range(estimate?.steps[id])! } : {}),
    };
  };
  const visit = (n: ViewNode) => {
    if (n.kind === "leaf") out[n.id] = leafCard(n.spec, n.id);
    else if (n.kind === "stack") {
      const owner = n.ownerId!;
      const card = leafCard(n.spec, n.id);
      const b = estimate?.steps[owner]?.branches;
      card.count = b ? (b.low === b.high ? `×${b.low}` : `×${b.low}–${b.high}`) : "×each";
      delete card.amount;
      out[n.id] = card;
    } else {
      const mode = n.spec.template
        ? n.spec.itemsFrom
          ? `for each from ${n.spec.itemsFrom}`
          : `for each of ${n.spec.items?.length ?? 0}`
        : n.spec.mode === "sequence"
          ? "in order"
          : "together";
      const card: CardInfo = { title: n.spec.title, status: badStep === n.id ? "failed" : "idle", lines: [], tags: [], mode };
      const amount = range(estimate?.steps[n.id]);
      if (amount) card.amount = amount;
      out[n.id] = card;
    }
    n.children.forEach(visit);
  };
  visit(view);
  return out;
}

export function Editor() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const [savedId, setSavedId] = useState<string | undefined>(params.get("saved") ?? undefined);
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [panelName, setPanelName] = useState(params.get("panel") ?? "starter");
  const [tree, setTree] = useState<Tree>();
  const [drafted, setDrafted] = useState<Drafted>();
  const [selected, setSelected] = useState<string>();
  const [check, setCheck] = useState<CheckResponse>();
  const [editError, setEditError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState<"save" | "run">();
  const [saved, setSaved] = useState<string>();
  const capTouched = useRef(false);

  // Start from the account's defaults.
  useEffect(() => {
    if (!me) return;
    if (!params.get("panel") && !params.get("draft") && me.user.settings.defaultPanel) setPanelName(me.user.settings.defaultPanel);
    if (me.user.settings.defaultCapUsd && !capTouched.current) {
      capTouched.current = true;
      setCap(me.user.settings.defaultCapUsd.toFixed(2));
    }
  }, [me, params]);

  // Load the tree: a fresh draft, one of the account's saved trees, or an example.
  useEffect(() => {
    if (!me) return;
    get<PanelEntry[]>("/api/panels")
      .then(setPanels)
      .catch((e: Error) => setLoadError(e.message));
    const path = params.get("path");
    if (params.get("draft")) {
      const d = loadDraft();
      if (!d) return setLoadError("The drafted tree wasn't found. Draft it again from the start page.");
      try {
        setTree(parseTree(d.tree));
        setPanelName(d.panel);
        if (d.drafted) setDrafted(d.drafted);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    } else if (params.get("saved")) {
      get<{ id: string; tree: unknown }>(`/api/trees/${encodeURIComponent(params.get("saved")!)}`)
        .then((r) => setTree(parseTree(r.tree)))
        .catch((e: Error) => setLoadError(e.message));
    } else if (path) {
      get<{ tree: unknown }>(`/api/tree?path=${encodeURIComponent(path)}`)
        .then((r) => setTree(parseTree(r.tree)))
        .catch((e: Error) => setLoadError(e.message));
    } else {
      setLoadError("Nothing to edit yet. Draft a plan or open a tree from the start page.");
    }
  }, [params, me?.user.id]);

  const panel = panels.find((p) => p.name === panelName)?.panel;

  // Ask the engine to validate and estimate, a moment after each edit.
  useEffect(() => {
    if (!tree || !panel) return;
    const t = setTimeout(() => {
      post<CheckResponse>("/api/check", { tree: treeToJson(tree), panel: panelName })
        .then((r) => {
          setCheck(r);
          if (r.ok && !capTouched.current) setCap(suggestCap(r.estimate.total.high));
        })
        .catch((e: Error) => setCheck({ ok: false, error: e.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [tree, panel, panelName]);

  const view = useMemo(() => (tree ? viewOfSpec(tree.root) : undefined), [tree]);
  const estimate = check?.ok ? check.estimate : undefined;
  const badStep = check && !check.ok ? /step "([^"]+)"/.exec(check.error)?.[1] : undefined;
  const cards = useMemo(() => (view && panel ? cardsFor(view, panel, estimate, badStep) : {}), [view, panel, estimate, badStep]);

  function edit(fn: (t: Tree) => Tree) {
    if (!tree) return;
    try {
      setTree(fn(tree));
      setEditError(undefined);
      setSaved(undefined);
    } catch (e) {
      setEditError((e as Error).message);
    }
  }

  async function save() {
    if (!tree) return;
    setBusy("save");
    try {
      const r = await post<{ id: string }>("/api/trees", savedId ? { tree: treeToJson(tree), id: savedId } : { tree: treeToJson(tree) });
      setSavedId(r.id);
      setSaved("Saved to your trees.");
      if (!params.get("saved")) router.replace(`/edit?saved=${r.id}&panel=${panelName}`);
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function run() {
    if (!tree) return;
    setBusy("run");
    try {
      const body: Record<string, unknown> = { tree: treeToJson(tree), panel: panelName, capUsd: Number(cap) };
      if (drafted) body.drafted = drafted;
      const r = await post<{ runId: string }>("/api/runs", body);
      router.push(`/runs/${r.runId}`);
    } catch (e) {
      setEditError((e as Error).message);
      setBusy(undefined);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorNote>{loadError}</ErrorNote>
      </div>
    );
  }
  if (!me || !tree || !view || !panel) return <div className="p-10 text-[13px] text-graphite">Loading…</div>;

  const capNum = Number(cap);
  const over = estimate && Number.isFinite(capNum) && estimate.total.high > capNum * 1e9;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 px-5 pt-4 pb-3">
        <input
          className="w-full border-0 border-b border-transparent bg-transparent text-[22px] font-bold tracking-[-0.01em] text-ink hover:border-rule focus:border-blue focus:outline-none"
          value={tree.goal}
          onChange={(e) => edit((t) => setGoal(t, e.target.value))}
          aria-label="Goal"
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-ink-soft">
          <label className="flex items-center gap-1.5">
            Cast from the
            <select
              className="border-0 border-b border-dashed border-graphite bg-transparent font-medium text-ink focus:border-blue focus:outline-none"
              value={panelName}
              onChange={(e) => setPanelName(e.target.value)}
            >
              {panels.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            panel
          </label>
          <span className="tnum">
            {estimate ? (
              <>
                Estimated <span className="font-semibold text-ink">{range(estimate.total)}</span> over {estimate.total.calls.low} to {estimate.total.calls.high} model calls
              </>
            ) : check && !check.ok ? (
              <span className="note text-red">Fix the plan to see an estimate</span>
            ) : (
              <span className="note text-graphite">Estimating…</span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5">
              Spend at most $
              <input
                className={`${inputClass} tnum w-[72px] py-1`}
                value={cap}
                inputMode="decimal"
                aria-label="Spending cap in dollars"
                onChange={(e) => {
                  capTouched.current = true;
                  setCap(e.target.value);
                }}
              />
            </label>
            <Button onClick={() => void save()} disabled={busy !== undefined}>
              {busy === "save" ? "Saving…" : savedId ? "Save changes" : "Save tree"}
            </Button>
            <Button tone="primary" onClick={() => void run()} disabled={!check?.ok || !(capNum > 0) || busy !== undefined}>
              {busy === "run" ? "Starting…" : "Run it"}
            </Button>
          </div>
        </div>
        <PanelNote panel={panel} compact />
        {((check && !check.ok) || editError || saved || over || drafted) && (
          <div className="flex flex-col gap-1.5 pt-1 text-[13px]">
            {check && !check.ok && <ErrorNote>{check.error}</ErrorNote>}
            {editError && <ErrorNote>{editError}</ErrorNote>}
            {over && <span className="note text-red">The high estimate is above what you'll spend, so the run may pause before it finishes.</span>}
            {saved && <span className="note text-ink">{saved}</span>}
            {drafted && (
              <span className="note text-graphite">
                Drafted by {shortModel(drafted.model)} in {drafted.attempts} attempt{drafted.attempts > 1 ? "s" : ""} for {formatUsd(drafted.costNanos)}, which counts towards what you spend.
                {drafted.repairs.length > 0 && ` Repaired: ${drafted.repairs.join("; ")}.`}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-t border-rule">
          <Canvas root={view} info={cards} selected={selected} onSelect={setSelected} />
        </div>
        <aside className="scroll-thin w-[380px] shrink-0 overflow-y-auto border-t border-l border-rule bg-sheet px-5 py-5">
          {selected ? (
            <StepForm
              tree={tree}
              panel={panel}
              id={selected}
              estimate={estimate}
              onPatch={(id, p: StepPatch) => edit((t) => updateStep(t, id, p))}
              onAdd={(parentId) =>
                edit((t) => {
                  const r = addChild(t, parentId);
                  setSelected(r.id);
                  return r.tree;
                })
              }
              onRemove={(id) =>
                edit((t) => {
                  const next = removeStep(t, id);
                  setSelected(undefined);
                  return next;
                })
              }
              onMove={(id, by) => edit((t) => moveStep(t, id, by))}
            />
          ) : (
            <div className="flex flex-col gap-3 text-[14px] leading-relaxed text-ink-soft">
              <p>Click a step to change its instructions, who does it, on which model, and who reviews it. Click a bracket to change how its steps run or to add one.</p>
              <p className="note text-graphite">The estimate is a range. The low end assumes every step works first time; the high end assumes every review sends work back and every reply uses its full length.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatUsd, usdToNanos } from "orch/src/core/money.ts";
import { useEffect, useState } from "react";
import { Landing } from "@/components/Landing";
import { PanelNote } from "@/components/PanelNote";
import { Button, ErrorNote, Status } from "@/components/ui";
import { get, post, type Config, type Examples, type PanelEntry, type PlanResponse, type RunListItem } from "@/lib/api";
import { saveDraft } from "@/lib/draft";
import { useSession, type Me } from "@/lib/session";

export default function Home() {
  const { session } = useSession();
  if (session.status === "loading") return null;
  if (session.status === "signed-out") return <Landing />;
  return <Workspace me={session.me} />;
}

interface SavedTree {
  id: string;
  goal: string;
  updatedAt: string;
}

function Workspace({ me }: { me: Me }) {
  const router = useRouter();
  const [config, setConfig] = useState<Config>();
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [examples, setExamples] = useState<Examples>();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [saved, setSaved] = useState<SavedTree[]>([]);
  const [goal, setGoal] = useState("");
  const [panel, setPanel] = useState(me.user.settings.defaultPanel ?? "starter");
  const needsKey = me.gateway === "openrouter" && !me.keys.some((k) => k.provider === "openrouter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([get<Config>("/api/config"), get<PanelEntry[]>("/api/panels"), get<Examples>("/api/examples"), get<RunListItem[]>("/api/runs"), get<SavedTree[]>("/api/trees")])
      .then(([c, p, e, r, t]) => {
        setConfig(c);
        setPanels(p);
        setExamples(e);
        setRuns(r);
        setSaved(t);
        setPanel((current) => (p.some((x) => x.name === current) ? current : (p[0]?.name ?? current)));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const planner = panels.find((p) => p.name === panel)?.panel.roles.find((r) => r.job === "plan");

  async function draft() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await post<PlanResponse>("/api/plan", { goal, panel });
      saveDraft({ tree: r.tree, panel, drafted: r.drafted });
      router.push("/edit?draft=1");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col px-6 pt-16 pb-24">
        <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-0.02em]">What do you want done?</h1>
        <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-ink-soft">
          orch drafts a plan as a tree of steps. You choose who does each step and on which model, then watch it play out.
        </p>

        <textarea
          className="mt-10 min-h-[3.5em] w-full resize-none border-0 border-b-2 border-ink bg-transparent pb-2 text-[24px] font-medium leading-snug text-ink placeholder:text-graphite-light focus:border-blue focus:outline-none"
          placeholder="Compare the five most popular open-source vector databases for a small startup."
          rows={2}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && goal.trim()) void draft();
          }}
          aria-label="Your goal"
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button tone="primary" disabled={!goal.trim() || busy || !planner || needsKey} onClick={() => void draft()}>
            {busy ? "Drafting the plan…" : "Draft the plan"}
          </Button>
          <label className="flex items-center gap-2 text-[14px] text-ink-soft">
            with the
            <select
              className="select-inline border-0 border-b border-dashed border-graphite bg-transparent text-[14px] font-medium text-ink focus:border-blue focus:outline-none"
              value={panel}
              onChange={(e) => setPanel(e.target.value)}
            >
              {panels.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            panel
          </label>
          {config && (
            <span className="note text-[13px] text-graphite">
              Drafting costs at most {formatUsd(usdToNanos(me.user.settings.planCapUsd ?? config.planCapUsd))}, on your OpenRouter key.
            </span>
          )}
          {panels.length > 0 && !planner && <span className="note text-[13px] text-red">This panel has no plan role, so it can't draft.</span>}
          {needsKey && (
            <Link href="/settings#keys" className="note text-[13px] text-red underline">
              Connect your OpenRouter key first
            </Link>
          )}
        </div>
        {panels.length > 0 && <PanelNote panel={panels.find((p) => p.name === panel)?.panel} />}
        {error && (
          <div className="mt-5">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {examples && (
          <section className="mt-14">
            <h2 className="text-[14px] font-semibold">Or start from one of these</h2>
            <ul className="mt-3 flex flex-col">
              {examples.goals.map((g) => (
                <li key={g.id}>
                  <button
                    onClick={() => setGoal(g.goal)}
                    className="w-full border-b border-rule py-2 text-left text-[15px] text-ink-soft transition-colors hover:text-ink"
                  >
                    {g.goal}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-14 grid gap-12 md:grid-cols-2">
          <section>
            <h2 className="text-[14px] font-semibold">Your saved trees</h2>
            {saved.length === 0 ? (
              <p className="note mt-3 text-[14px] text-graphite">Trees you save from the editor show up here.</p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {saved.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <Link href={`/edit?saved=${t.id}&panel=${panel}`} className="group block border-b border-rule py-2">
                      <span className="line-clamp-1 text-[14px] text-ink group-hover:underline">{t.goal}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <h2 className="mt-10 text-[14px] font-semibold">Example trees</h2>
            <ul className="mt-3 flex flex-col">
              {examples?.trees.map((t) => (
                <li key={t.path}>
                  <Link href={`/edit?path=${encodeURIComponent(t.path)}&panel=${panel}`} className="group block border-b border-rule py-2">
                    <span className="line-clamp-1 text-[14px] text-ink group-hover:underline">{t.goal}</span>
                    <span className="text-[12px] text-graphite">{t.path}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="text-[14px] font-semibold">Recent runs</h2>
            {runs.length === 0 ? (
              <p className="note mt-3 text-[14px] text-graphite">Runs you start show up here.</p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {runs.slice(0, 10).map((r) => (
                  <li key={r.runId}>
                    <Link href={`/runs/${r.runId}`} className="group flex items-baseline gap-3 border-b border-rule py-2">
                      <span className="line-clamp-1 flex-1 text-[14px] text-ink group-hover:underline">{r.goal}</span>
                      <span className="tnum text-[12px] text-ink-soft">{formatUsd(r.spentNanos)}</span>
                      <Status status={r.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

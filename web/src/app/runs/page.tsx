"use client";

import Link from "next/link";
import { formatUsd } from "orch/src/core/money.ts";
import { useEffect, useState } from "react";
import { ErrorNote, Status } from "@/components/ui";
import { get, type RunListItem } from "@/lib/api";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunListItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    get<RunListItem[]>("/api/runs").then(setRuns, (e: Error) => setError(e.message));
  }, []);
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
        {error && <ErrorNote>{error}</ErrorNote>}
        {runs?.length === 0 && <p className="text-[13px] text-graphite">No runs yet.</p>}
        <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule">
          {runs?.map((r) => (
            <li key={r.runId}>
              <Link href={`/runs/${r.runId}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-paper">
                <span className="tnum text-[11px] text-graphite">{r.createdAt.slice(0, 16).replace("T", " ")}</span>
                <span className="line-clamp-1 flex-1 text-[13px] text-ink">{r.goal}</span>
                <span className="tnum text-[11px] text-ink-soft">
                  {formatUsd(r.spentNanos)} of {formatUsd(r.cap)}
                </span>
                <span className="w-12 text-right tnum text-[11px] text-graphite">{r.gateway}</span>
                <Status status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

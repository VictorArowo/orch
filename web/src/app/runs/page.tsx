"use client";

import Link from "next/link";
import { formatUsd } from "orch/src/core/money.ts";
import { useEffect, useState } from "react";
import { ErrorNote, Status } from "@/components/ui";
import { get, type RunListItem } from "@/lib/api";
import { useMe } from "@/lib/session";

export default function RunsPage() {
  const me = useMe();
  const [runs, setRuns] = useState<RunListItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (me) get<RunListItem[]>("/api/runs").then(setRuns, (e: Error) => setError(e.message));
  }, [me]);
  if (!me) return null;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 pt-12 pb-24">
        <h1 className="text-[26px] font-bold tracking-[-0.02em]">Runs</h1>
        {error && <ErrorNote>{error}</ErrorNote>}
        {runs?.length === 0 && (
          <p className="note text-[15px] text-graphite">
            No runs yet. <Link href="/" className="text-blue underline">Draft a plan</Link> to start one.
          </p>
        )}
        <ul className="flex flex-col">
          {runs?.map((r) => (
            <li key={r.runId}>
              <Link href={`/runs/${r.runId}`} className="group flex items-baseline gap-4 border-b border-rule py-3">
                <span className="tnum w-36 shrink-0 text-[13px] text-graphite">
                  {new Date(r.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="line-clamp-1 flex-1 text-[15px] text-ink group-hover:underline">{r.goal}</span>
                <span className="tnum text-[13px] text-ink-soft">
                  {formatUsd(r.spentNanos)} of {formatUsd(r.cap)}
                </span>
                {r.gateway === "mock" && <span className="note text-[13px] text-graphite">mock</span>}
                <Status status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

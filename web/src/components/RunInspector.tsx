"use client";

import type { AttemptReason } from "orch/src/core/events.ts";
import { formatUsd } from "orch/src/core/money.ts";
import { isLeaf, isStale, outputOf, stepCost, stepStatus, type AttemptState, type RunState } from "orch/src/core/state.ts";
import { useState } from "react";
import { Markdown } from "./Markdown";
import { StepControls } from "./StepControls";
import { shortModel, Status } from "./ui";

const REASON: Record<AttemptReason, string> = {
  initial: "first try",
  check: "after the check sent it back",
  critique: "after the critique",
  format: "after a malformed reply",
  length: "with more room, after running out",
  error: "after an error",
  rerun: "re-run",
};

const PURPOSE = { do: "draft", check: "check", critique: "critique" } as const;

function Output({ text }: { text: string }) {
  return (
    <div className="rounded-[6px] border border-rule bg-sheet px-4 py-3">
      <Markdown text={text} />
    </div>
  );
}

function Attempt({ state, attempt }: { state: RunState; attempt: AttemptState }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const calls = attempt.callIds.map((c) => state.calls[c]!);
  const doCall = calls.find((c) => c.purpose === "do");
  const outcome =
    attempt.status === "accepted" ? (
      <span className="font-semibold text-ink">kept</span>
    ) : attempt.status === "rejected" ? (
      <span className="note text-red">sent back</span>
    ) : (
      <span className="rounded-[3px] bg-highlight px-1 font-semibold text-ink">working</span>
    );
  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-4">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
        <span className="font-bold">Attempt {attempt.n}</span>
        <span className="text-ink-soft">
          <span className="text-blue">{attempt.role}</span> on {shortModel(attempt.model)}
        </span>
        <span className="note text-graphite">{REASON[attempt.reason]}</span>
        <span className="ml-auto text-[13px]">{outcome}</span>
      </div>
      {attempt.notes.length > 0 && (
        <ul className="note flex flex-col gap-1 border-l-2 border-red/60 pl-3 text-[13px] text-red">
          {attempt.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <table className="tnum w-full table-fixed text-[12.5px] text-ink-soft">
        <colgroup>
          <col className="w-[62px]" />
          <col />
          <col className="w-[82px]" />
          <col className="w-[44px]" />
        </colgroup>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} className="align-baseline" title={c.usage ? `${c.usage.promptTokens} tokens in, ${c.usage.completionTokens} out` : undefined}>
              <td className="py-0.5 text-graphite">{PURPOSE[c.purpose]}</td>
              <td className="truncate py-0.5 pr-2">{shortModel(c.model)}</td>
              <td className="py-0.5 pr-2 text-right whitespace-nowrap">{c.status === "open" ? <span className="note text-graphite">calling…</span> : formatUsd(c.costNanos)}</td>
              <td className="py-0.5 text-right whitespace-nowrap text-graphite">{c.ms ? `${(c.ms / 1000).toFixed(1)}s` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {calls.some((c) => c.error) && (
        <ul className="note flex flex-col gap-0.5 text-[12.5px] text-red">
          {calls
            .filter((c) => c.error)
            .map((c) => (
              <li key={c.id}>
                {PURPOSE[c.purpose]} on {shortModel(c.model)} failed: {c.error}
              </li>
            ))}
        </ul>
      )}
      {attempt.reviews.map((r, i) => (
        <div key={i} className="flex flex-col gap-1 text-[13px]">
          <div>
            {r.purpose === "check" ? "Checked" : "Critiqued"} by <span className="text-blue">{r.role}</span>:{" "}
            {r.verdict === "pass" ? (
              <span className="font-semibold">{r.purpose === "check" ? "passed" : "no objections"}</span>
            ) : (
              <span className="note text-red">{r.purpose === "check" ? "asked for changes" : "objected"}</span>
            )}
          </div>
          {r.votes.length > 1 && (
            <div className="flex flex-wrap gap-x-4 text-[12.5px] text-ink-soft">
              {r.votes.map((v, j) => (
                <span key={j}>
                  {shortModel(v.model)} <span className={v.verdict === "revise" ? "note text-red" : v.verdict === "pass" ? "font-semibold" : "note text-graphite"}>{v.verdict}</span>
                </span>
              ))}
            </div>
          )}
          {r.notes.length > 0 && (
            <ul className="note flex flex-col gap-1 border-l-2 border-red/60 pl-3 text-red">
              {r.notes.map((n, j) => (
                <li key={j}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {attempt.output !== undefined && <Output text={attempt.output} />}
      {doCall && (
        <button className="self-start text-[13px] text-blue underline-offset-2 hover:underline" onClick={() => setShowPrompt((s) => !s)}>
          {showPrompt ? "Hide what it was told" : "Show what it was told"}
        </button>
      )}
      {showPrompt &&
        doCall?.messages.map((m, i) => (
          <div key={i} className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-graphite">{m.role === "system" ? "Role instructions" : "Step prompt"}</span>
            <div className="whitespace-pre-wrap rounded-[6px] bg-paper p-3 text-[12.5px] leading-relaxed text-ink-soft">{m.content}</div>
          </div>
        ))}
    </section>
  );
}

export function RunInspector({ state, selected }: { state: RunState; selected?: string | undefined; version: number }) {
  const isTemplate = !!selected?.endsWith(".template") && !state.steps[selected];
  const id = isTemplate ? undefined : selected;
  const step = id ? state.steps[id] : undefined;

  if (isTemplate && selected) {
    const owner = state.steps[selected.slice(0, -".template".length)];
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[19px] font-bold leading-tight tracking-[-0.01em]">{owner?.spec.template?.title}</h2>
          <div className="mt-0.5 text-[12px] text-graphite">{selected}</div>
        </div>
        {owner?.spec.template?.instructions && <p className="text-[14px] leading-relaxed text-ink-soft">{owner.spec.template.instructions}</p>}
        <StepControls key={selected} state={state} id={selected} />
      </div>
    );
  }

  if (!step) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[14px] text-ink-soft">
          Cast from the <span className="font-semibold text-ink">{state.panel.name}</span> panel.
          {state.drafted && ` Drafting the plan cost ${formatUsd(state.drafted.costNanos)}.`}
        </p>
        {state.status === "done" ? (
          <>
            <h2 className="text-[16px] font-bold">The result</h2>
            <Output text={outputOf(state, state.rootId)} />
          </>
        ) : (
          <p className="note text-[14px] text-graphite">Click a step to see what it was told, what it did and what it cost. The result appears here when the run is done.</p>
        )}
      </div>
    );
  }

  const status = stepStatus(state, step.id);
  const attempts = step.attemptIds.map((a) => state.attempts[a]!);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <Status status={status} />
        {status === "done" && isStale(state, step.id) && <span className="note text-[13px] text-blue">stale: an input has changed since</span>}
        <span className="tnum ml-auto text-[13px] text-ink-soft">{formatUsd(stepCost(state, step.id))}</span>
      </div>
      <div>
        <h2 className="text-[19px] font-bold leading-tight tracking-[-0.01em]">{step.spec.title}</h2>
        <div className="mt-0.5 text-[12px] text-graphite">{step.id}</div>
      </div>
      {step.spec.instructions && <p className="text-[14px] leading-relaxed text-ink-soft">{step.spec.instructions}</p>}
      {step.warning && <p className="note text-[13px] text-red">{step.warning}</p>}
      {step.error && <p className="note text-[13px] text-red">{step.error}</p>}
      {step.skipped && <p className="note text-[13px] text-graphite">Skipped: the steps after it got no output from it.</p>}
      {(step.edits ?? 0) > 0 && <p className="note text-[13px] text-blue">Edited during the run.</p>}
      <StepControls key={step.id} state={state} id={step.id} />
      {isLeaf(step) ? (
        attempts.length ? (
          attempts.map((a) => <Attempt key={a.id} state={state} attempt={a} />)
        ) : (
          <p className="note text-[14px] text-graphite">Not started yet.</p>
        )
      ) : (
        status === "done" && <Output text={outputOf(state, step.id)} />
      )}
    </div>
  );
}

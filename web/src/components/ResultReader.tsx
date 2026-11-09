"use client";

import { formatUsd } from "orch/src/core/money.ts";
import { isStale, outputOf, treeOrder, type RunState } from "orch/src/core/state.ts";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Button } from "./ui";

function words(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`|-]+/g, " ")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
}

// The run's result, set for reading: full width, its length, and a copy of
// the Markdown to take elsewhere.
export function ResultReader({ state, onClose }: { state: RunState; onClose: () => void }) {
  const text = outputOf(state, state.rootId);
  const close = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const stale = treeOrder(state).some((id) => isStale(state, id));
  const warnings = Object.values(state.steps).filter((s) => s.warning);

  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-ink/30 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="The result" className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-[8px] bg-sheet shadow-[0_24px_64px_-24px_rgba(23,25,30,0.45)]">
        <div className="flex items-start gap-4 border-b border-rule px-6 py-4 sm:px-10">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-graphite">The result</div>
            <h2 className="mt-0.5 text-[17px] font-bold leading-snug tracking-[-0.01em]">{state.goal}</h2>
            <div className="tnum mt-1 text-[13px] text-ink-soft">
              {words(text).toLocaleString()} words. Cost {formatUsd(state.spentNanos)}, cast from the {state.panel.name} panel.
            </div>
          </div>
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? "Copied" : "Copy Markdown"}
          </Button>
          <Button ref={close} onClick={onClose} aria-label="Close the result">
            Close
          </Button>
        </div>
        {(stale || warnings.length > 0) && (
          <div className="note flex flex-col gap-1 border-b border-rule px-6 py-3 text-[13px] text-red sm:px-10">
            {stale && <span>Some steps read outputs that have changed since, so parts of this may be out of date.</span>}
            {warnings.map((s) => (
              <span key={s.id}>
                {s.spec.title}: {s.warning}.
              </span>
            ))}
          </div>
        )}
        <div className="scroll-thin flex-1 overflow-y-auto px-6 py-8 sm:px-10">
          <div className="mx-auto max-w-[68ch] text-[16px]">
            <Markdown text={text} />
          </div>
        </div>
      </div>
    </div>
  );
}

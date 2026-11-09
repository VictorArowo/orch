import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ tone = "plain", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "plain" | "primary" | "danger" }) {
  const styles = {
    plain: "border-ink/20 bg-sheet text-ink hover:border-ink/50",
    primary: "border-ink bg-ink text-paper hover:bg-ink-soft",
    danger: "border-red/40 bg-sheet text-red hover:border-red",
  }[tone];
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center gap-1.5 rounded-[5px] border px-3.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${styles} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="note text-[12px] text-graphite">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "rounded-[5px] border border-rule bg-sheet px-2.5 py-1.5 text-[14px] text-ink placeholder:text-graphite-light focus:border-blue focus:outline-none";

const STATUS_WORD: Record<string, [string, string]> = {
  ready: ["Ready", "text-graphite"],
  running: ["Running", "text-ink bg-highlight px-1.5 rounded-[3px]"],
  paused: ["Paused", "text-red"],
  done: ["Done", "text-ink"],
  stopped: ["Stopped", "text-red"],
  pending: ["Not started", "text-graphite"],
  blocked: ["Waiting on budget", "text-red"],
  failed: ["Failed", "text-red"],
};

export function Status({ status }: { status: string }) {
  const [word, tone] = STATUS_WORD[status] ?? [status, "text-graphite"];
  return <span className={`text-[13px] font-semibold ${tone}`}>{word}</span>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="note border-l-2 border-red pl-3 text-[14px] text-red">{children}</div>;
}

export function shortModel(model: string): string {
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

import { modelsOf, type Panel } from "orch/src/core/panel.ts";
import { shortModel } from "./ui";

// What a panel is, in a line, and who plays each part.
export function PanelNote({ panel, compact }: { panel: Panel | undefined; compact?: boolean }) {
  if (!panel) return null;
  const cast = panel.roles
    .filter((r) => r.job !== "plan")
    .map((r) => `${r.name} ${modelsOf(r.models).map(shortModel).join(r.models.kind === "jury" ? " + " : " → ")}`);
  return (
    <div className={`flex max-w-2xl flex-col gap-1 ${compact ? "" : "mt-3"}`}>
      {panel.description && <p className="text-[14px] leading-relaxed text-ink-soft">{panel.description}</p>}
      {!compact && (
        <details className="text-[13px] text-graphite">
          <summary className="cursor-pointer select-none hover:text-ink">Who plays what</summary>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {cast.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

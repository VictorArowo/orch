"use client";

import type { TreeEstimate } from "orch/src/core/estimate.ts";
import { formatUsd } from "orch/src/core/money.ts";
import { modelsOf, type Panel } from "orch/src/core/panel.ts";
import type { StepSpec, Tree } from "orch/src/core/tree.ts";
import { allSteps, findStep, listSteps, type StepPatch } from "orch/src/view/edit.ts";
import { Button, Field, inputClass } from "./ui";

interface Props {
  tree: Tree;
  panel: Panel;
  id: string;
  estimate?: TreeEstimate | undefined;
  onPatch: (id: string, patch: StepPatch) => void;
  onAdd: (parentId: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
}

function within(step: StepSpec, id: string): boolean {
  return step.id === id || step.children.some((c) => within(c, id));
}

export function StepForm({ tree, panel, id, estimate, onPatch, onAdd, onRemove, onMove }: Props) {
  const found = findStep(tree.root, id);
  if (!found) return null;
  const { step, parent, templateOf } = found;
  const isRoot = !parent && !templateOf;
  const est = estimate?.steps[templateOf ? templateOf.id : step.id];
  const doRoles = panel.roles.filter((r) => r.job === "do");
  const checkRoles = panel.roles.filter((r) => r.job === "check");
  const critiqueRoles = panel.roles.filter((r) => r.job === "critique");
  const allModels = [...new Set(panel.roles.filter((r) => r.job === "do").flatMap((r) => modelsOf(r.models)))];
  const patch = (p: StepPatch) => onPatch(id, p);

  // Steps this one could read: anything outside its own subtree and its ancestors'.
  const readable = allSteps(tree).filter((s) => !within(s, step.id) && !within(s, templateOf?.id ?? step.id) && !within(s, id) && s.id !== tree.root.id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="tnum text-[12px] text-graphite">{templateOf ? `${templateOf.id} · each branch` : step.id}</div>
        {est && (
          <div className="tnum text-[12px] text-ink-soft">
            {formatUsd(est.low)}–{formatUsd(est.high)}
          </div>
        )}
      </div>
      {templateOf && (
        <p className="text-[12px] text-ink-soft">
          This is the template for every branch of the fan-out. <span className="tnum text-ink">{"{{item}}"}</span> in the title and instructions is replaced by each item.
        </p>
      )}

      <Field label="Title">
        <input className={`${inputClass} w-full`} value={step.title} onChange={(e) => patch({ title: e.target.value })} />
      </Field>

      {step.mode === "leaf" ? (
        <>
          <Field label="Instructions" hint="The step sees only these and its inputs, never the rest of the plan.">
            <textarea className={`${inputClass} w-full min-h-32 resize-y`} value={step.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              <select className={`${inputClass} w-full`} value={step.role ?? ""} onChange={(e) => patch({ role: e.target.value })}>
                <option value="">{doRoles[0]?.name} (default)</option>
                {doRoles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select className={`${inputClass} w-full`} value={step.model ?? ""} onChange={(e) => patch({ model: e.target.value })}>
                <option value="">the role's</option>
                {allModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Check">
              <select className={`${inputClass} w-full`} value={step.check ?? ""} onChange={(e) => patch({ check: e.target.value })}>
                <option value="">none</option>
                {checkRoles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                    {r.models.kind === "jury" ? " (jury)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Critique">
              <select className={`${inputClass} w-full`} value={step.critique ?? ""} onChange={(e) => patch({ critique: e.target.value })}>
                <option value="">none</option>
                {critiqueRoles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Output">
              <select className={`${inputClass} w-full`} value={step.output} onChange={(e) => patch({ output: e.target.value as "text" | "list" })}>
                <option value="text">text</option>
                <option value="list">a list to fan out over</option>
              </select>
            </Field>
            {step.check && (
              <Field label="Send-backs">
                <input
                  type="number"
                  min={0}
                  max={5}
                  className={`${inputClass} w-full`}
                  value={step.maxRetries ?? 2}
                  onChange={(e) => patch({ maxRetries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })}
                />
              </Field>
            )}
          </div>
          {!templateOf && readable.length > 0 && (
            <Field label="Reads" hint="Leave all unticked to read the previous step of a sequence.">
              <div className="scroll-thin flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-rule p-2">
                {readable.map((s) => {
                  const on = step.inputs?.includes(s.id) ?? false;
                  return (
                    <label key={s.id} className="flex items-center gap-2 text-[12px] text-ink-soft">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => patch({ inputs: on ? (step.inputs ?? []).filter((x) => x !== s.id) : [...(step.inputs ?? []), s.id] })}
                      />
                      <span className="tnum text-graphite">{s.id}</span> {s.title}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
        </>
      ) : (
        <>
          {step.template ? (
            <FanOutFields tree={tree} step={step} onPatch={patch} />
          ) : (
            <Field label="Children run">
              <select className={`${inputClass} w-full`} value={step.mode} onChange={(e) => patch({ mode: e.target.value as "sequence" | "parallel" })}>
                <option value="sequence">in order</option>
                <option value="parallel">at the same time</option>
              </select>
            </Field>
          )}
          {!step.template && (
            <Button onClick={() => onAdd(step.id)} className="self-start">
              Add a step
            </Button>
          )}
        </>
      )}

      {!isRoot && !templateOf && (
        <div className="flex gap-2 border-t border-rule pt-4">
          <Button onClick={() => onMove(step.id, -1)} aria-label="Move up">
            ↑ Earlier
          </Button>
          <Button onClick={() => onMove(step.id, 1)} aria-label="Move down">
            ↓ Later
          </Button>
          <Button tone="danger" className="ml-auto" onClick={() => onRemove(step.id)}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function FanOutFields({ tree, step, onPatch }: { tree: Tree; step: StepSpec; onPatch: (p: StepPatch) => void }) {
  const sources = listSteps(tree).filter((s) => s.id !== step.id);
  const fixed = !step.itemsFrom;
  return (
    <>
      <Field label="Fan out over">
        <select
          className={`${inputClass} w-full`}
          value={fixed ? "" : step.itemsFrom}
          onChange={(e) => (e.target.value ? onPatch({ itemsFrom: e.target.value, items: [] }) : onPatch({ itemsFrom: "", items: step.items?.length ? step.items : ["first", "second"] }))}
        >
          <option value="">a fixed list</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              the list from {s.id}
            </option>
          ))}
        </select>
      </Field>
      {fixed && (
        <Field label="Items" hint="One per line. Each becomes a branch.">
          <textarea
            className={`${inputClass} w-full min-h-24 resize-y tnum text-[12px]`}
            value={(step.items ?? []).join("\n")}
            onChange={(e) => onPatch({ items: e.target.value.split("\n").filter((x, i, all) => x.trim() || i === all.length - 1) })}
          />
        </Field>
      )}
    </>
  );
}

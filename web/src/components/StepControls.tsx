"use client";

import type { StepPatch } from "orch/src/core/events.ts";
import { modelsOf } from "orch/src/core/panel.ts";
import { dependentsOf, isHeld, isLeaf, stepStatus, type RunState } from "orch/src/core/state.ts";
import type { StepSpec } from "orch/src/core/tree.ts";
import { useState } from "react";
import { Button, ErrorNote, Field, inputClass, shortModel } from "./ui";
import { post } from "@/lib/api";

// Steering for one step of a live or finished run.

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function EditForm({ state, id, spec, onDone, canRerun }: { state: RunState; id: string; spec: StepSpec; onDone: () => void; canRerun: boolean }) {
  const panel = state.panel;
  const [title, setTitle] = useState(spec.title);
  const [instructions, setInstructions] = useState(spec.instructions);
  const [role, setRole] = useState(spec.role ?? "");
  const [model, setModel] = useState(spec.model ?? "");
  const [check, setCheck] = useState(spec.check ?? "");
  const [critique, setCritique] = useState(spec.critique ?? "");
  const b = useBusy();
  const doRoles = panel.roles.filter((r) => r.job === "do");
  const models = [...new Set(doRoles.flatMap((r) => modelsOf(r.models)))];

  const patch = (): StepPatch => {
    const p: StepPatch = {};
    if (title !== spec.title) p.title = title;
    if (instructions !== spec.instructions) p.instructions = instructions;
    if (role !== (spec.role ?? "")) p.role = role || null;
    if (model !== (spec.model ?? "")) p.model = model || null;
    if (check !== (spec.check ?? "")) p.check = check || null;
    if (critique !== (spec.critique ?? "")) p.critique = critique || null;
    return p;
  };
  const save = (rerun: boolean) =>
    b.run(async () => {
      const p = patch();
      if (Object.keys(p).length) await post(`/api/runs/${state.runId}/steps/${id}/edit`, { patch: p });
      if (rerun) await post(`/api/runs/${state.runId}/rerun`, { stepIds: [id], cascade: true });
      onDone();
    });

  return (
    <div className="flex flex-col gap-3 rounded-[6px] border border-blue/40 bg-paper p-4">
      <Field label="Title">
        <input className={`${inputClass} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea className={`${inputClass} min-h-28 w-full resize-y`} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role">
          <select className={`${inputClass} w-full`} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{doRoles[0]?.name} (default)</option>
            {doRoles.map((r) => (
              <option key={r.name}>{r.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <select className={`${inputClass} w-full`} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">the role's</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {shortModel(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Check">
          <select className={`${inputClass} w-full`} value={check} onChange={(e) => setCheck(e.target.value)}>
            <option value="">none</option>
            {panel.roles
              .filter((r) => r.job === "check")
              .map((r) => (
                <option key={r.name}>{r.name}</option>
              ))}
          </select>
        </Field>
        <Field label="Critique">
          <select className={`${inputClass} w-full`} value={critique} onChange={(e) => setCritique(e.target.value)}>
            <option value="">none</option>
            {panel.roles
              .filter((r) => r.job === "critique")
              .map((r) => (
                <option key={r.name}>{r.name}</option>
              ))}
          </select>
        </Field>
      </div>
      {b.error && <ErrorNote>{b.error}</ErrorNote>}
      <div className="flex flex-wrap gap-2">
        {canRerun ? (
          <>
            <Button tone="primary" disabled={b.busy} onClick={() => void save(true)}>
              Save and re-run
            </Button>
            <Button disabled={b.busy} onClick={() => void save(false)}>
              Save for later
            </Button>
          </>
        ) : (
          <Button tone="primary" disabled={b.busy} onClick={() => void save(false)}>
            Save
          </Button>
        )}
        <Button disabled={b.busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="note text-[12px] text-graphite">
        {canRerun ? "Re-running also re-runs the steps that use this one's output." : "Changes apply from the step's next attempt; work already under way finishes as it was."}
      </p>
    </div>
  );
}

function Rerun({ state, id }: { state: RunState; id: string }) {
  const [model, setModel] = useState("");
  const dependents = dependentsOf(state, [id]).filter((d) => stepStatus(state, d) === "done");
  const [cascade, setCascade] = useState(true);
  const b = useBusy();
  const step = state.steps[id]!;
  const models = [...new Set(state.panel.roles.filter((r) => r.job === "do").flatMap((r) => modelsOf(r.models)))];
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={b.busy}
          onClick={() => void b.run(() => post(`/api/runs/${state.runId}/rerun`, { stepIds: [id], cascade: cascade && dependents.length > 0, ...(model ? { model } : {}) }))}
        >
          {isLeaf(step) ? "Re-run" : "Re-run everything in it"}
        </Button>
        {isLeaf(step) && (
          <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            on
            <select className={`${inputClass} py-1`} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model for the re-run">
              <option value="">the same model</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {shortModel(m)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {dependents.length > 0 && (
        <label className="flex items-start gap-2 text-[13px] text-ink-soft">
          <input type="checkbox" className="mt-0.5" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
          <span>
            and the {dependents.length} step{dependents.length > 1 ? "s" : ""} that use its output ({dependents.map((d) => state.steps[d]!.spec.title).join(", ")})
          </span>
        </label>
      )}
      {b.error && <ErrorNote>{b.error}</ErrorNote>}
    </div>
  );
}

export function StepControls({ state, id }: { state: RunState; id: string }) {
  const [editing, setEditing] = useState(false);
  const b = useBusy();
  const template = id.endsWith(".template") && !state.steps[id];
  const ownerId = template ? id.slice(0, -".template".length) : id;
  const step = state.steps[ownerId];
  if (!step) return null;
  const status = stepStatus(state, ownerId);
  const leaf = isLeaf(step);
  const finished = status === "done" || status === "failed";
  const action = (what: "hold" | "release" | "skip") => b.run(() => post(`/api/runs/${state.runId}/steps/${ownerId}/${what}`, {}));
  const live = state.status === "running" || state.status === "paused";

  if (template) {
    return editing ? (
      <EditForm state={state} id={id} spec={step.spec.template!} onDone={() => setEditing(false)} canRerun={false} />
    ) : (
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-ink-soft">Every branch of this fan-out will be made from this template once the list it reads is ready.</p>
        <div>
          <Button onClick={() => setEditing(true)}>Edit the template</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {!finished && !step.held && live && (
          <Button disabled={b.busy} onClick={() => void action("hold")} title="Stops any call it has under way; that call may still be billed">
            {leaf ? "Pause this step" : "Pause this branch"}
          </Button>
        )}
        {step.held && (
          <Button tone="primary" disabled={b.busy} onClick={() => void action("release")}>
            {leaf ? "Resume this step" : "Resume this branch"}
          </Button>
        )}
        {leaf && !finished && status !== "running" && (
          <Button disabled={b.busy} onClick={() => void action("skip")}>
            Skip
          </Button>
        )}
        {leaf && status === "failed" && (
          <Button disabled={b.busy} onClick={() => void action("skip")} title="Count it as done with no output, so the run can carry on">
            Skip and carry on
          </Button>
        )}
        {leaf && !editing && <Button onClick={() => setEditing(true)}>Edit</Button>}
      </div>
      {isHeld(state, ownerId) && !step.held && <p className="note text-[13px] text-blue">Paused with the branch it's in.</p>}
      {b.error && <ErrorNote>{b.error}</ErrorNote>}
      {editing && <EditForm state={state} id={ownerId} spec={step.spec} onDone={() => setEditing(false)} canRerun={finished} />}
      {!editing && (finished || (!leaf && step.childIds.some((c) => ["done", "failed"].includes(stepStatus(state, c))))) && <Rerun state={state} id={ownerId} />}
    </div>
  );
}

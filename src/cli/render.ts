import type { TreeEstimate } from "../core/estimate.ts";
import { formatUsd } from "../core/money.ts";
import { defaultDoRole, findRole, modelsOf, type Panel } from "../core/panel.ts";
import type { StepSpec, Tree } from "../core/tree.ts";
import { isLeaf, isStale, stepCost, stepStatus, treeOrder, type RunState, type StepState, type StepStatus } from "../core/state.ts";

export interface RenderOptions {
  color: boolean;
  width: number;
  now?: number;
}

const ANSI = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

type Paint = (style: keyof typeof ANSI, s: string) => string;

function painter(color: boolean): Paint {
  return (style, s) => (color && s ? `${ANSI[style]}${s}${ANSI.reset}` : s);
}

const SPINNER = ["◐", "◓", "◑", "◒"];

function icon(status: StepStatus, paint: Paint, now: number): string {
  switch (status) {
    case "done":
      return paint("green", "✓");
    case "failed":
      return paint("red", "✗");
    case "blocked":
      return paint("magenta", "$");
    case "running":
      return paint("yellow", SPINNER[Math.floor(now / 150) % SPINNER.length]!);
    default:
      return paint("dim", "·");
  }
}

export function shortModel(model: string): string {
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function fit(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  // Trim visible characters while keeping escape codes intact.
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length && visible < width - 1; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + "…" + (out.includes("\x1b[") ? ANSI.reset : "");
}

function pad(s: string, n: number): string {
  const len = visibleLength(s);
  return len >= n ? s : s + " ".repeat(n - len);
}

export function modelsUsed(state: RunState, step: StepState): string[] {
  const models: string[] = [];
  for (const id of step.attemptIds) {
    const m = shortModel(state.attempts[id]!.model);
    if (models[models.length - 1] !== m) models.push(m);
  }
  return models;
}

function reviewNotes(state: RunState, step: StepState): string[] {
  const notes: string[] = [];
  const attempts = step.attemptIds.map((a) => state.attempts[a]!);
  const sentBack = attempts.filter((a) => a.rejected?.reason === "check").length;
  const format = attempts.filter((a) => a.rejected?.reason === "format").length;
  const critiqued = attempts.filter((a) => a.rejected?.reason === "critique").length;
  const juries = attempts.flatMap((a) => a.reviews).filter((r) => r.votes.length > 1);
  if (sentBack) notes.push(`sent back ${sentBack}×`);
  if (format) notes.push(`malformed ${format}×`);
  if (critiqued) notes.push(`revised after critique`);
  for (const j of juries) {
    const revise = j.votes.filter((v) => v.verdict === "revise").length;
    if (revise && revise < j.votes.length) notes.push(`jury split ${j.votes.length - revise}-${revise}`);
  }
  return notes;
}

export function renderHeader(state: RunState, paint: Paint): string {
  const status = {
    ready: paint("dim", "ready"),
    running: paint("yellow", "running"),
    paused: paint("magenta", "paused"),
    done: paint("green", "done"),
    stopped: paint("red", "stopped"),
  }[state.status];
  const parts = [
    `${paint("bold", "orch")} ${state.runId}`,
    status,
    `spent ${formatUsd(state.spentNanos)}`,
    state.reservedNanos ? `reserved ${formatUsd(state.reservedNanos)}` : "",
    `cap ${formatUsd(state.cap)}`,
  ].filter(Boolean);
  return parts.join(paint("dim", " · "));
}

export function renderTree(state: RunState, opts: RenderOptions): string[] {
  const paint = painter(opts.color);
  const now = opts.now ?? Date.now();
  const lines: string[] = [renderHeader(state, paint), paint("dim", state.goal), ""];
  const stale = new Map<string, boolean>();

  const visit = (id: string, prefix: string, last: boolean, isRoot: boolean) => {
    const step = state.steps[id]!;
    const status = stepStatus(state, id);
    const branch = isRoot ? "" : last ? "└─ " : "├─ ";
    let line = `${prefix}${branch}${icon(status, paint, now)} ${paint("bold", step.id)} ${step.spec.title}`;
    const cols: string[] = [];
    if (isLeaf(step)) {
      const att = step.attemptIds.length ? state.attempts[step.attemptIds[step.attemptIds.length - 1]!] : undefined;
      cols.push(paint("cyan", att?.role ?? step.spec.role ?? ""));
      const models = modelsUsed(state, step);
      if (models.length) cols.push(models.join(" → "));
      if (step.attemptIds.length > 1) cols.push(`${step.attemptIds.length} attempts`);
      const open = att?.callIds.map((c) => state.calls[c]!).find((c) => c.status === "open");
      if (open) cols.push(paint("yellow", { do: "working", check: "checking", critique: "critiquing" }[open.purpose]));
    } else {
      const kids = step.childIds;
      const done = kids.filter((k) => stepStatus(state, k) === "done").length;
      cols.push(paint("dim", step.spec.mode === "parallel" ? `parallel ${done}/${kids.length}` : `sequence ${done}/${kids.length}`));
      if (!step.expanded) cols.push(paint("dim", `waits for ${step.spec.itemsFrom}`));
    }
    const cost = stepCost(state, id);
    if (cost) cols.push(formatUsd(cost));
    if (isLeaf(step)) for (const n of reviewNotes(state, step)) cols.push(paint("dim", n));
    if (step.warning) cols.push(paint("yellow", "⚠ check unresolved"));
    if (step.blocked) cols.push(paint("magenta", `needs ${formatUsd(step.blocked.neededNanos)}`));
    if (status === "done" && isStale(state, id, stale)) cols.push(paint("magenta", "stale"));
    if (step.error) cols.push(paint("red", step.error));
    line += "  " + cols.join(paint("dim", " · "));
    lines.push(fit(line, opts.width));
    const childPrefix = isRoot ? "" : prefix + (last ? "   " : "│  ");
    step.childIds.forEach((c, i) => visit(c, childPrefix, i === step.childIds.length - 1, false));
  };
  visit(state.rootId, "", true, true);
  return lines;
}

function preview(text: string, n: number): string {
  const flat = text.replace(/[*#`_>|-]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

// The end-of-run table: one row per leaf with its role, models, status,
// attempts, cost and the start of its output.
export function renderSummary(state: RunState, opts: RenderOptions): string[] {
  const paint = painter(opts.color);
  const rows = treeOrder(state)
    .map((id) => state.steps[id]!)
    .filter(isLeaf)
    .map((step) => {
      const accepted = step.acceptedAttemptId ? state.attempts[step.acceptedAttemptId] : undefined;
      return {
        id: step.id,
        role: accepted?.role ?? step.spec.role ?? "",
        model: modelsUsed(state, step).join(" → ") || "-",
        status: stepStatus(state, step.id) + (stepStatus(state, step.id) === "done" && isStale(state, step.id) ? " (stale)" : ""),
        attempts: String(step.attemptIds.length),
        cost: formatUsd(stepCost(state, step.id)),
        output: accepted?.output ?? step.error ?? "",
      };
    });
  const head = { id: "step", role: "role", model: "model", status: "status", attempts: "tries", cost: "cost", output: "output" };
  const keys = ["id", "role", "model", "status", "attempts", "cost"] as const;
  const widths = Object.fromEntries(keys.map((k) => [k, Math.max(head[k].length, ...rows.map((r) => r[k].length))])) as Record<
    (typeof keys)[number],
    number
  >;
  const fixed = keys.reduce((n, k) => n + widths[k] + 2, 0);
  const outWidth = Math.max(20, opts.width - fixed);
  const line = (r: typeof head, style?: "dim") => {
    const s = keys.map((k) => pad(r[k], widths[k])).join("  ") + "  " + preview(r.output, outWidth);
    return style ? paint(style, s) : s;
  };
  const out = [line(head, "dim")];
  for (const r of rows) out.push(fit(line(r), opts.width));
  out.push("");
  const summary = `Total ${formatUsd(state.spentNanos)} of ${formatUsd(state.cap)} cap`;
  const unknown = Object.values(state.calls).filter((c) => !c.costKnown && c.status === "failed").length;
  const notes: string[] = [];
  if (state.drafted) notes.push(`${formatUsd(state.drafted.costNanos)} for drafting the tree`);
  if (unknown) notes.push(`${unknown} interrupted call${unknown > 1 ? "s" : ""} counted at worst case`);
  out.push(paint("bold", summary) + (notes.length ? paint("dim", ` (includes ${notes.join(" and ")})`) : ""));
  return out;
}

// A drafted tree before it runs: each step's role, models, reviews and cost
// estimate. Fan-outs over another step's list show their template.
export function renderPlan(tree: Tree, panel: Panel, estimate: TreeEstimate, opts: RenderOptions): string[] {
  const paint = painter(opts.color);
  const range = (r: { low: number; high: number }) => paint("dim", `${formatUsd(r.low)}–${formatUsd(r.high)}`);
  const lines: string[] = [paint("dim", tree.goal), ""];

  const describe = (s: StepSpec): string[] => {
    const cols: string[] = [];
    if (s.mode === "leaf") {
      const role = s.role ? findRole(panel, s.role) : defaultDoRole(panel);
      cols.push(paint("cyan", role?.name ?? "?"));
      cols.push(s.model ? shortModel(s.model) : role ? modelsOf(role.models).map(shortModel).join(" → ") : "");
      if (s.output === "list") cols.push(paint("dim", "returns a list"));
    } else if (s.itemsFrom) {
      cols.push(paint("dim", `parallel, one branch per item from ${s.itemsFrom}`));
    } else {
      cols.push(paint("dim", `${s.mode}`));
    }
    if (s.inputs?.length) cols.push(paint("dim", `reads ${s.inputs.join(", ")}`));
    if (s.check) cols.push(`check ${s.check}`);
    if (s.critique) cols.push(`critique ${s.critique}`);
    return cols;
  };

  const visit = (s: StepSpec, prefix: string, last: boolean, isRoot: boolean, label?: string) => {
    const branch = isRoot ? "" : last ? "└─ " : "├─ ";
    const est = estimate.steps[s.id];
    const cols = describe(s);
    if (est) {
      cols.push(range(est));
      if (est.branches) {
        const b = est.branches;
        cols.push(paint("dim", b.low === b.high ? `assumes ${b.low} branches` : `assumes ${b.low}–${b.high} branches`));
      }
    }
    lines.push(fit(`${prefix}${branch}${paint("bold", label ?? s.id)} ${s.title}  ${cols.join(paint("dim", " · "))}`, opts.width));
    const childPrefix = isRoot ? "" : prefix + (last ? "   " : "│  ");
    if (s.itemsFrom && s.template) {
      visit(s.template, childPrefix, true, false, "each");
      return;
    }
    s.children.forEach((c, i) => visit(c, childPrefix, i === s.children.length - 1, false));
  };
  visit(tree.root, "", true, true);
  const t = estimate.total;
  lines.push("");
  lines.push(`Estimate ${formatUsd(t.low)}–${formatUsd(t.high)} over ${t.calls.low}–${t.calls.high} model calls`);
  return lines;
}

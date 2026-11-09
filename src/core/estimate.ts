import { costOf, type Nanos, type Price } from "./money.js";
import { defaultDoRole, findRole, ladderModel, modelsOf, type Panel, type Role } from "./panel.js";
import { apply, emptyState, inputIds } from "./state.js";
import { walk, type Limits, type StepSpec, type Tree } from "./tree.js";
import { DEFAULT_CRITIQUE_ROUNDS, DEFAULT_MAX_RETRIES } from "./step-machine.js";

// A rough pre-run estimate. Low assumes every step works first time and
// writes a typical amount; high assumes every check sends work back as often
// as it can, every critique forces a revision, and every reply uses its whole
// token limit. Real runs usually land near the low end.

export interface Range {
  low: Nanos;
  high: Nanos;
}

export interface StepEstimate extends Range {
  calls: { low: number; high: number };
  // For a fan-out over another step's list: how many branches were assumed.
  branches?: { low: number; high: number };
}

export interface TreeEstimate {
  steps: Record<string, StepEstimate>;
  total: StepEstimate;
}

// Typical reply sizes in tokens, by kind of call.
const TYPICAL = { text: 300, list: 40, check: 40, critique: 80 };
const FRAMING_TOKENS = 150;
const DEFAULT_DO_TOKENS = 1024;
const DEFAULT_REVIEW_TOKENS = 512;

const tokensOf = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// How many items a list step will probably return, if its wording says ("the
// five most popular", "top 3").
export function guessCount(spec: StepSpec): number | undefined {
  const text = `${spec.title} ${spec.instructions}`.toLowerCase();
  const digits = /\b([2-9]|1[0-9]|20)\b/.exec(text);
  if (digits) return Number(digits[1]);
  const word = NUMBER_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(text));
  return word ? NUMBER_WORDS.indexOf(word) + 2 : undefined;
}

export async function estimateTree(
  tree: Tree,
  panel: Panel,
  limits: Limits,
  priceOf: (model: string) => Promise<Price>,
): Promise<TreeEstimate> {
  const state = apply(emptyState("estimate"), {
    type: "run.created",
    goal: tree.goal,
    root: tree.root,
    panel,
    cap: 0,
    limits,
    concurrency: 1,
    gateway: "",
    runId: "estimate",
    seq: 1,
    at: new Date(0).toISOString(),
  });
  const prices = new Map<string, Price>();
  const price = async (m: string) => {
    let p = prices.get(m);
    if (!p) prices.set(m, (p = await priceOf(m)));
    return p;
  };
  const steps: Record<string, StepEstimate> = {};
  const outputs = new Map<string, Range>();

  const doRole = (spec: StepSpec): Role => (spec.role ? findRole(panel, spec.role)! : defaultDoRole(panel));
  const maxTokensOf = (spec: StepSpec) => spec.maxTokens ?? doRole(spec).settings.maxTokens ?? DEFAULT_DO_TOKENS;

  const branches = (spec: StepSpec): { low: number; high: number } => {
    if (!spec.itemsFrom) return { low: spec.children.length, high: spec.children.length };
    const n = guessCount(state.steps[spec.itemsFrom]!.spec);
    return n ? { low: Math.min(n, limits.maxFanOut), high: Math.min(n, limits.maxFanOut) } : { low: Math.min(3, limits.maxFanOut), high: limits.maxFanOut };
  };

  // Expected output size of a step, in tokens, used as the input size of the
  // steps that read it.
  const outputOf = (id: string, spec: StepSpec): Range => {
    const cached = outputs.get(id);
    if (cached) return cached;
    let r: Range;
    if (spec.mode === "leaf") {
      const max = maxTokensOf(spec);
      r = spec.output === "list" ? { low: TYPICAL.list, high: Math.min(max, 200) } : { low: Math.min(TYPICAL.text, max), high: max };
    } else if (spec.mode === "sequence") {
      const last = spec.children[spec.children.length - 1]!;
      r = outputOf(last.id, last);
    } else if (spec.itemsFrom) {
      const one = outputOf(`${id}.template`, spec.template!);
      const b = branches(spec);
      r = { low: one.low * b.low, high: one.high * b.high };
    } else {
      r = spec.children.reduce((acc, c) => add(acc, outputOf(c.id, c)), { low: 0, high: 0 });
    }
    outputs.set(id, r);
    return r;
  };

  // Every spec by id, including the steps inside fan-out templates.
  const specs = new Map<string, StepSpec>();
  walk(tree.root, (s) => specs.set(s.id, s));
  const inputTokens = (ids: string[]): Range =>
    ids.reduce((acc, i) => (specs.has(i) ? add(acc, outputOf(i, specs.get(i)!)) : acc), { low: 0, high: 0 });

  const callCost = async (model: string, prompt: number, completion: number) => costOf(await price(model), prompt, completion);

  const leaf = async (spec: StepSpec, inputs: string[]): Promise<StepEstimate> => {
    const role = doRole(spec);
    const max = maxTokensOf(spec);
    const out = outputOf(spec.id, spec);
    const base = FRAMING_TOKENS + tokensOf(`${tree.goal} ${spec.title} ${spec.instructions} ${role.instructions}`);
    const inp = inputTokens(inputs);
    const check = spec.check ? findRole(panel, spec.check)! : undefined;
    const critique = spec.critique ? findRole(panel, spec.critique)! : undefined;
    const reviewCalls = async (r: Role, typical: number, draft: number, high: boolean) => {
      let cost = 0;
      const prompt = FRAMING_TOKENS + tokensOf(`${spec.instructions} ${r.instructions}`) + draft;
      for (const m of modelsOf(r.models)) {
        cost += await callCost(m, prompt, high ? (r.settings.maxTokens ?? DEFAULT_REVIEW_TOKENS) : typical);
      }
      return cost;
    };

    // Low: one attempt, typical sizes, reviews pass.
    const model0 = spec.model ?? ladderModel(role.models, 0);
    let low = await callCost(model0, base + inp.low, out.low);
    let callsLow = 1;
    if (check) {
      low += await reviewCalls(check, TYPICAL.check, out.low, false);
      callsLow += modelsOf(check.models).length;
    }
    if (critique) {
      low += await reviewCalls(critique, TYPICAL.critique, out.low, false);
      callsLow += modelsOf(critique.models).length;
    }

    // High: every send-back and critique round used, each reply at its limit.
    const retries = check ? (spec.maxRetries ?? DEFAULT_MAX_RETRIES) : 0;
    const rounds = critique ? (spec.critiqueRounds ?? DEFAULT_CRITIQUE_ROUNDS) : 0;
    let high = 0;
    let callsHigh = 0;
    for (let k = 0; k <= retries + rounds; k++) {
      const model = spec.model ?? ladderModel(role.models, Math.min(k, retries));
      // A revision also carries the previous draft and the notes.
      const prompt = base + inp.high + (k > 0 ? max + 100 : 0);
      high += await callCost(model, prompt, max);
      callsHigh++;
      if (check) {
        high += await reviewCalls(check, TYPICAL.check, max, true);
        callsHigh += modelsOf(check.models).length;
      }
      if (critique && k < rounds) {
        high += await reviewCalls(critique, TYPICAL.critique, max, true);
        callsHigh += modelsOf(critique.models).length;
      }
    }
    return { low, high, calls: { low: callsLow, high: callsHigh } };
  };

  // Estimate a subtree that isn't part of the run yet (a fan-out template).
  const detached = async (spec: StepSpec, inherited: string[]): Promise<StepEstimate> => {
    if (spec.mode === "leaf") return leaf(spec, spec.inputs ?? inherited);
    if (spec.itemsFrom) {
      const one = await detached(spec.template!, inherited);
      const b = branches(spec);
      return { low: one.low * b.low, high: one.high * b.high, calls: { low: one.calls.low * b.low, high: one.calls.high * b.high } };
    }
    const kids: StepEstimate[] = [];
    for (const [i, c] of spec.children.entries()) {
      const prev = spec.mode === "sequence" && i > 0 ? [spec.children[i - 1]!.id] : inherited;
      kids.push(await detached(c, c.inputs ?? prev));
    }
    return sum(kids);
  };

  const visit = async (spec: StepSpec): Promise<StepEstimate> => {
    let est: StepEstimate;
    if (spec.mode === "leaf") {
      est = await leaf(spec, inputIds(state, spec.id));
    } else if (spec.itemsFrom) {
      // The branches don't exist until the list is known: estimate one from
      // the template and multiply.
      const t = spec.template!;
      const one = await detached(t, t.inputs ?? inputIds(state, spec.id));
      const b = branches(spec);
      est = {
        low: one.low * b.low,
        high: one.high * b.high,
        calls: { low: one.calls.low * b.low, high: one.calls.high * b.high },
        branches: b,
      };
    } else {
      const kids: StepEstimate[] = [];
      for (const c of spec.children) kids.push(await visit(c));
      est = sum(kids);
    }
    steps[spec.id] = est;
    return est;
  };

  const total = await visit(tree.root);
  return { steps, total };
}

function add(a: Range, b: Range): Range {
  return { low: a.low + b.low, high: a.high + b.high };
}

function sum(xs: StepEstimate[]): StepEstimate {
  return xs.reduce<StepEstimate>(
    (acc, x) => ({ low: acc.low + x.low, high: acc.high + x.high, calls: { low: acc.calls.low + x.calls.low, high: acc.calls.high + x.calls.high } }),
    { low: 0, high: 0, calls: { low: 0, high: 0 } },
  );
}

import type { ChatMessage, Vote } from "./events.js";
import type { Role } from "./panel.js";
import type { StepSpec } from "./tree.js";

// Each step sees only its own instructions and inputs, never the run's history.

export interface InputBlock {
  stepId: string;
  title: string;
  output: string;
}

const JOB_FRAMING: Record<Role["job"], string> = {
  plan: "You plan work as a tree of steps.",
  do: "You carry out one step of a larger piece of work. Do only this step.",
  check: "You review the output of one step of a larger piece of work.",
  critique: "You argue against a draft, raising the strongest objections you can find.",
};

function system(role: Role): ChatMessage {
  const parts = [`You are the "${role.name}" in a team of AI agents. ${JOB_FRAMING[role.job]}`];
  if (role.instructions.trim()) parts.push(role.instructions.trim());
  return { role: "system", content: parts.join("\n\n") };
}

function inputsText(inputs: InputBlock[]): string {
  if (!inputs.length) return "";
  return inputs.map((i) => `<input step="${i.stepId}" title="${i.title}">\n${i.output}\n</input>`).join("\n\n");
}

export function doMessages(opts: {
  role: Role;
  goal: string;
  step: StepSpec;
  inputs: InputBlock[];
  notes: string[];
  previousOutput?: string;
}): ChatMessage[] {
  const { role, goal, step, inputs, notes } = opts;
  const parts: string[] = [`The overall goal: ${goal}`, `Your step: ${step.title}`];
  if (step.instructions.trim()) parts.push(step.instructions.trim());
  if (step.item) parts.push(`This step is for: ${step.item}`);
  const inp = inputsText(inputs);
  if (inp) parts.push(`Outputs of earlier steps:\n\n${inp}`);
  if (notes.length) {
    if (opts.previousOutput) parts.push(`Your previous output:\n\n<previous>\n${opts.previousOutput}\n</previous>`);
    parts.push(`It was sent back with these notes. Address each one:\n${notes.map((n) => `- ${n}`).join("\n")}`);
  }
  parts.push(
    step.output === "list"
      ? `Reply with only a JSON array of short strings, for example ["first", "second"]. No other text.`
      : `Reply with the result of this step only, in Markdown. Be concise.`,
  );
  return [system(role), { role: "user", content: parts.join("\n\n") }];
}

export function checkMessages(opts: { role: Role; goal: string; step: StepSpec; output: string }): ChatMessage[] {
  const { role, goal, step, output } = opts;
  const parts = [
    `The overall goal: ${goal}`,
    `The step under review: ${step.title}`,
    step.instructions.trim() ? `Its instructions:\n${step.instructions.trim()}` : "",
    `Its output:\n\n<output>\n${output}\n</output>`,
    `Decide whether the output does what the step asked. Reply with only JSON: {"verdict": "pass" | "revise", "notes": ["what to fix", ...]}. Use "revise" only for real problems, and keep notes specific.`,
  ].filter(Boolean);
  return [system(role), { role: "user", content: parts.join("\n\n") }];
}

export function critiqueMessages(opts: { role: Role; goal: string; step: StepSpec; output: string }): ChatMessage[] {
  const { role, goal, step, output } = opts;
  const parts = [
    `The overall goal: ${goal}`,
    `The draft is the output of: ${step.title}`,
    `<draft>\n${output}\n</draft>`,
    `Raise your strongest objections to this draft: claims that are wrong, unsupported or missing. Reply with only JSON: {"objections": ["...", ...]}. Return an empty list if you have none worth raising.`,
  ];
  return [system(role), { role: "user", content: parts.join("\n\n") }];
}

// Find the first JSON value of the expected kind in a model reply, tolerating
// code fences and surrounding prose.
export function extractJson(text: string, open: "[" | "{"): unknown {
  const close = open === "[" ? "]" : "}";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) throw new Error(`no JSON ${open === "[" ? "array" : "object"} found`);
  return JSON.parse(text.slice(start, end + 1));
}

export function parseList(text: string): string[] {
  const value = extractJson(text, "[");
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error("expected a JSON array of strings");
  const items = value.map((v) => v.trim()).filter(Boolean);
  if (!items.length) throw new Error("the list is empty");
  return items;
}

export function parseVerdict(model: string, text: string): Vote {
  try {
    const v = extractJson(text, "{") as { verdict?: unknown; notes?: unknown };
    const verdict = v.verdict === "pass" || v.verdict === "revise" ? v.verdict : "abstain";
    const notes = Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string") : [];
    return { model, verdict, notes };
  } catch {
    return { model, verdict: "abstain", notes: [] };
  }
}

export function parseObjections(model: string, text: string): Vote {
  try {
    const v = extractJson(text, "{") as { objections?: unknown };
    const notes = Array.isArray(v.objections) ? v.objections.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
    return { model, verdict: notes.length ? "revise" : "pass", notes };
  } catch {
    return { model, verdict: "abstain", notes: [] };
  }
}

// A jury sends work back only when a strict majority of the votes cast say so.
// Abstentions (unparseable replies) don't count either way.
export function tally(votes: Vote[]): { verdict: "pass" | "revise"; notes: string[] } {
  const cast = votes.filter((v) => v.verdict !== "abstain");
  const revise = cast.filter((v) => v.verdict === "revise");
  if (revise.length * 2 > cast.length) {
    return { verdict: "revise", notes: [...new Set(revise.flatMap((v) => v.notes))] };
  }
  return { verdict: "pass", notes: [] };
}

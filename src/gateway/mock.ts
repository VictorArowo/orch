import { costOf, priceFromUsdPerToken, type Price } from "../core/money.js";
import type { CompletionRequest, CompletionResult, Gateway } from "./gateway.js";
import { mockListLength, mockPlan } from "./mock-plan.js";

// A deterministic stand-in for a real gateway: no key, no network. Replies are
// derived from a hash of the request, so the same tree gives the same run.

export type MockReply = string | { text: string; completionTokens?: number; costNanos?: number };

export interface MockOptions {
  // Return a reply to override the default, or undefined to fall through.
  // Throwing here simulates a failed call.
  respond?: (req: CompletionRequest, callIndex: number) => MockReply | undefined | Promise<MockReply | undefined>;
  // Milliseconds per call: a number, or a function for per-call control.
  latency?: number | ((req: CompletionRequest) => number);
  prices?: Record<string, Price>;
  defaultPrice?: Price;
  // Report cost the way OpenRouter does. When false, the engine computes it.
  reportCost?: boolean;
  // Share of steps whose first check asks for changes, and whether a first
  // critique raises an objection. Both deterministic per step.
  checkReviseRate?: number;
  critiqueObjects?: boolean;
}

const usd = (prompt: number, completion: number) => priceFromUsdPerToken({ prompt: prompt / 1e6, completion: completion / 1e6 });

// Rough per-million prices so mock runs show plausible spend.
const DEFAULT_PRICES: Record<string, Price> = {
  "deepseek/deepseek-v4.1-flash": usd(0.05, 0.57),
  "google/gemini-3.8-flash": usd(0.83, 4.13),
  "anthropic/claude-sonnet-5.5": usd(2, 10),
  "anthropic/claude-haiku-5.5": usd(0.1, 0.5),
  "openai/gpt-5.6-luna": usd(0.2, 1.2),
  "qwen/qwen3.8-flash": usd(0.15, 0.47),
};

export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const tokens = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

const PHRASES = [
  "is strong on raw query speed but asks more of you operationally",
  "is the easiest to start with and the hardest to outgrow gracefully",
  "has a managed tier that removes most of the setup work",
  "fits best when the data already lives next to it",
  "trades some recall for much lower memory use",
  "has an active community and frequent releases",
];

const LIST_POOL = ["Option A", "Option B", "Option C", "Option D", "Option E", "Option F", "Option G", "Option H", "Option I", "Option J"];

export class MockGateway implements Gateway {
  readonly name = "mock";
  private calls = 0;
  private checksSeen = new Map<string, number>();
  private critiquesSeen = new Map<string, number>();

  constructor(private readonly opts: MockOptions = {}) {}

  async price(model: string): Promise<Price> {
    return this.opts.prices?.[model] ?? DEFAULT_PRICES[model] ?? this.opts.defaultPrice ?? usd(0.5, 2);
  }

  get callCount(): number {
    return this.calls;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const index = this.calls++;
    const latency = typeof this.opts.latency === "function" ? this.opts.latency(req) : (this.opts.latency ?? 0);
    if (latency > 0) await sleep(latency, signal);
    signal?.throwIfAborted();

    let reply = await this.opts.respond?.(req, index);
    reply ??= this.defaultReply(req);
    const r = typeof reply === "string" ? { text: reply } : reply;

    const promptTokens = req.messages.reduce((n, m) => n + tokens(m.content) + 4, 0);
    const completionTokens = Math.min(r.completionTokens ?? tokens(r.text), req.maxTokens);
    const result: CompletionResult = { text: r.text, usage: { promptTokens, completionTokens } };
    if (r.costNanos !== undefined) result.costNanos = r.costNanos;
    else if (this.opts.reportCost !== false) result.costNanos = costOf(await this.price(req.model), promptTokens, completionTokens);
    return result;
  }

  private defaultReply(req: CompletionRequest): string {
    const { purpose, stepId, output } = req.meta;
    const user = req.messages[req.messages.length - 1]?.content ?? "";
    const h = hash(`${req.model}|${user}`);

    if (purpose === "plan") {
      const prompt = req.messages.find((m) => m.role === "user")?.content ?? "";
      return JSON.stringify(mockPlan(prompt), null, 2);
    }
    if (purpose === "check") {
      const seen = this.checksSeen.get(stepId) ?? 0;
      this.checksSeen.set(stepId, seen + 1);
      const rate = this.opts.checkReviseRate ?? 0.3;
      const revise = seen === 0 && (hash(stepId) % 1000) / 1000 < rate;
      return JSON.stringify(
        revise ? { verdict: "revise", notes: ["Back the main claim with a concrete number or source."] } : { verdict: "pass", notes: [] },
      );
    }
    if (purpose === "critique") {
      const seen = this.critiquesSeen.get(stepId) ?? 0;
      this.critiquesSeen.set(stepId, seen + 1);
      const objects = (this.opts.critiqueObjects ?? true) && seen === 0;
      return JSON.stringify({
        objections: objects ? ["The recommendation ignores the cost of running it yourself at small scale."] : [],
      });
    }
    if (output === "list") {
      // As many items as the step's own wording asks for, five by default.
      const step = user.slice(user.indexOf("Your step:"));
      return JSON.stringify(LIST_POOL.slice(0, mockListLength(step)));
    }

    const title = /Your step: (.*)/.exec(user)?.[1] ?? stepId;
    const subject = /This step is for: (.*)/.exec(user)?.[1] ?? title;
    const inputs = (user.match(/<input /g) ?? []).length;
    const revised = user.includes("It was sent back with these notes");
    const lines = [
      `**${title}** (mock reply from ${req.model})`,
      "",
      `- ${subject} ${PHRASES[h % PHRASES.length]}.`,
      `- ${PHRASES[(h >>> 8) % PHRASES.length]!.replace(/^./, (c) => c.toUpperCase())}.`,
    ];
    if (inputs) lines.push(`- Drew on ${inputs} earlier step${inputs === 1 ? "" : "s"}.`);
    if (revised) lines.push(`- Revised to address the notes it was sent back with.`);
    return lines.join("\n");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

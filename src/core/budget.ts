import type { ChatMessage } from "./events.ts";
import type { Nanos, Price } from "./money.ts";

// Before a call we don't know how many tokens the prompt is, only its text.
// Byte-level BPE tokenizers never produce more tokens than the text has UTF-8
// bytes, so bytes plus a little per-message framing is a true upper bound.
// It is loose (roughly 4x for English), but it is released after the call.
const PER_MESSAGE_OVERHEAD = 8;
const PER_REQUEST_OVERHEAD = 16;

export function promptTokensUpperBound(messages: ChatMessage[]): number {
  let total = PER_REQUEST_OVERHEAD;
  for (const m of messages) total += Buffer.byteLength(m.content, "utf8") + PER_MESSAGE_OVERHEAD;
  return total;
}

// The most a call can cost: every prompt token at the upper bound, and the
// model using its whole completion limit.
export function worstCase(price: Price, messages: ChatMessage[], maxTokens: number): Nanos {
  return Math.ceil(price.request + price.prompt * promptTokensUpperBound(messages) + price.completion * maxTokens);
}

export interface BudgetView {
  cap: Nanos;
  spentNanos: Nanos;
  reservedNanos: Nanos;
}

// ok: reserve it now.
// wait: it doesn't fit next to the calls in flight, but will once they settle.
// blocked: it won't fit even after everything in flight settles at zero cost.
export type Decision = { kind: "ok" } | { kind: "wait" } | { kind: "blocked"; availableNanos: Nanos };

export function decide(b: BudgetView, amount: Nanos): Decision {
  if (b.spentNanos + b.reservedNanos + amount <= b.cap) return { kind: "ok" };
  if (b.spentNanos + amount <= b.cap) return { kind: "wait" };
  return { kind: "blocked", availableNanos: Math.max(0, b.cap - b.spentNanos) };
}

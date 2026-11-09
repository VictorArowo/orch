import type { ChatMessage, Purpose, Usage } from "../core/events.js";
import type { Nanos, Price } from "../core/money.js";
import type { RoleSettings } from "../core/panel.js";

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  settings: RoleSettings;
  // Not sent to real models. The mock gateway uses it to shape its replies.
  meta: { purpose: Purpose | "plan"; stepId: string; output: "text" | "list" };
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  // The real cost if the gateway reports one; otherwise computed from the price.
  costNanos?: Nanos;
}

export interface Gateway {
  readonly name: string;
  price(model: string): Promise<Price>;
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

import { priceFromUsdPerToken, usdToNanos, type Price } from "../core/money.ts";
import { GatewayError, type CompletionRequest, type CompletionResult, type Gateway } from "./gateway.ts";
import { redact } from "./redact.ts";

const BASE = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 180_000;

interface ModelsResponse {
  data: { id: string; pricing?: { prompt?: string; completion?: string; request?: string } }[];
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

// The public price list is the same for everyone, so it is shared.
let sharedPrices: Promise<Map<string, Price>> | undefined;

// OpenRouter: one key reaches every model, and each response reports what the
// call really cost, which is what the budget reconciles to. The key can be a
// function, so a stored key is decrypted only when a call is about to be made.
export class OpenRouterGateway implements Gateway {
  readonly name = "openrouter";

  constructor(private readonly apiKey: string | (() => Promise<string>)) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  }

  private loadPrices(): Promise<Map<string, Price>> {
    sharedPrices ??= (async () => {
      const res = await fetch(`${BASE}/models`);
      if (!res.ok) throw new GatewayError(`couldn't load OpenRouter prices (HTTP ${res.status})`, true);
      const body = (await res.json()) as ModelsResponse;
      const map = new Map<string, Price>();
      for (const m of body.data) {
        const prompt = Number(m.pricing?.prompt);
        const completion = Number(m.pricing?.completion);
        const request = Number(m.pricing?.request ?? 0);
        if (![prompt, completion, request].every((n) => Number.isFinite(n) && n >= 0)) continue;
        map.set(m.id, priceFromUsdPerToken({ prompt, completion, request }));
      }
      return map;
    })();
    sharedPrices.catch(() => (sharedPrices = undefined));
    return sharedPrices;
  }

  async price(model: string): Promise<Price> {
    const p = (await this.loadPrices()).get(model);
    if (!p) throw new GatewayError(`OpenRouter has no fixed price for "${model}" (is the id right?)`, false);
    return p;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const key = typeof this.apiKey === "string" ? this.apiKey : await this.apiKey();
    const clean = (s: string) => redact(s, [key]);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      usage: { include: true },
    };
    if (req.settings.temperature !== undefined) body.temperature = req.settings.temperature;
    if (req.settings.reasoningEffort) body.reasoning = { effort: req.settings.reasoningEffort };

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "orch",
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new GatewayError(clean(`request to OpenRouter failed: ${(err as Error).message}`), true);
    }
    const text = await res.text();
    let json: ChatResponse;
    try {
      json = JSON.parse(text) as ChatResponse;
    } catch {
      throw new GatewayError(clean(`OpenRouter returned HTTP ${res.status} with a non-JSON body`), res.status >= 500);
    }
    if (!res.ok || json.error) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw new GatewayError(clean(`OpenRouter error (${res.status}): ${msg}`), retryable);
    }
    const content = json.choices?.[0]?.message?.content ?? "";
    const result: CompletionResult = {
      text: content,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
    if (typeof json.usage?.cost === "number") result.costNanos = usdToNanos(json.usage.cost);
    return result;
  }
}

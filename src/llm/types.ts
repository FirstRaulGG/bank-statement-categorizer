// The one seam between the agent and a language model.
//
// The agent needs very little from a model: text in, JSON text out. Keeping the interface this
// small is what lets the tests run the whole pipeline with a scripted fake, and what keeps every
// guarantee in code instead of in a provider feature.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  /** The model that actually answered. */
  model: string;
  /** The reply was cut off at the output limit. What arrived is in `text`. */
  truncated?: boolean;
}

export interface LlmCallOptions {
  /** Aborts the request. The agent uses it for the per-call timeout and the run's time budget. */
  signal?: AbortSignal;
}

export interface LlmClient {
  complete(messages: readonly LlmMessage[], options?: LlmCallOptions): Promise<LlmResult>;
}

/**
 * Thrown when the provider could not be reached or would not serve the request: bad or exhausted
 * credentials, rate limits, server errors, timeouts, network failures. The run stops asking and
 * leaves the remaining transactions pending, to be picked up by the next run.
 *
 * A 400 is deliberately not one of these. A malformed request is a bug in the caller, and hiding
 * it behind "the model is unavailable" would let it live forever.
 */
export class LlmUnavailableError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmUnavailableError";
    this.status = status;
  }
}

export function isUnavailableStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/**
 * Thrown when the provider answered but there is nothing to parse (a refusal, an empty reply).
 * The call was still billed, so it carries the usage when the provider reported it.
 */
export class LlmOutputError extends Error {
  readonly usage: LlmUsage | undefined;
  readonly model: string | undefined;
  constructor(message: string, usage?: LlmUsage, model?: string) {
    super(message);
    this.name = "LlmOutputError";
    this.usage = usage;
    this.model = model;
  }
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/**
 * Pulls the JSON object out of a model reply. Models wrap JSON in code fences or add a sentence
 * before it often enough that refusing those replies would waste a retry on pure formatting.
 * Returns `null` when no object can be parsed.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

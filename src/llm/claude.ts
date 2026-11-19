// Claude adapter, on the official Anthropic SDK.

import Anthropic from "@anthropic-ai/sdk";

import { LlmOutputError, LlmUnavailableError, isUnavailableStatus } from "./types.js";
import type { LlmCallOptions, LlmClient, LlmMessage, LlmResult, LlmUsage } from "./types.js";

export interface ClaudeClientOptions {
  /**
   * A Claude model id. There is no default on purpose: categorizing is a small classification
   * task, and which tier is good enough for your statements is what the eval is for.
   */
  model: string;
  /** Defaults to the SDK's own credential resolution (`ANTHROPIC_API_KEY`, profiles, ...). */
  apiKey?: string;
  maxTokens?: number;
  /** Thinking depth and token spend, for models that accept it. Not sent unless set. */
  effort?: "low" | "medium" | "high";
  /**
   * Ask the API to re-run a declined request on a fallback model inside the same call. Off unless
   * set. When it is used, the reply may come from another model than the one asked for, and cost
   * is estimated at the price of the model that answered.
   */
  refusalFallback?: boolean;
  /** Inject a preconfigured SDK client (tests, proxies). */
  client?: Anthropic;
}

function usageOf(usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): LlmUsage {
  return {
    inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export class ClaudeClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly options: ClaudeClientOptions;

  constructor(options: ClaudeClientOptions) {
    if (!options.model) throw new Error("ClaudeClient needs a model id");
    this.client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.options = options;
  }

  async complete(messages: readonly LlmMessage[], call: LlmCallOptions = {}): Promise<LlmResult> {
    const { model, maxTokens = 16000, effort, refusalFallback } = this.options;
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const turns: Anthropic.MessageParam[] = messages
      .filter((m): m is LlmMessage & { role: "user" | "assistant" } => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await this.client.beta.messages
      .create(
        {
          model,
          max_tokens: maxTokens,
          ...(effort ? { output_config: { effort } } : {}),
          // The system prompt (rules and the category list) is identical for every batch and the
          // transactions come after it, so it is the cacheable prefix. A prefix below the model's
          // minimum simply does not cache: check `cachedInputTokens` rather than assume.
          ...(system ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] } : {}),
          messages: turns,
          ...(refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: call.signal },
      )
      .catch((err: unknown) => {
        if (err instanceof Anthropic.APIError) {
          // No status means the request never got an answer: aborted, timed out or no network.
          if (err.status === undefined || isUnavailableStatus(err.status)) {
            throw new LlmUnavailableError(`the model provider is unavailable (${err.status ?? "no response"})`, err.status);
          }
        }
        throw err;
      });

    const usage = usageOf(response.usage);
    // A refusal arrives as HTTP 200. Check before reading the content.
    if (response.stop_reason === "refusal") {
      throw new LlmOutputError("the model declined to answer this batch", usage, response.model);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      usage,
      // A reply cut off at the token limit is still returned: the entries that arrived whole are
      // good, and they were paid for.
      ...(response.stop_reason === "max_tokens" ? { truncated: true } : {}),
    };
  }
}

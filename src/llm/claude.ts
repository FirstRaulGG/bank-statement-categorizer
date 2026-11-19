// Claude adapter, on the official Anthropic SDK.

import Anthropic from "@anthropic-ai/sdk";

import { LlmOutputError, LlmUnavailableError, isUnavailableStatus } from "./types.js";
import type { LlmCallOptions, LlmClient, LlmMessage, LlmResult } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export interface ClaudeClientOptions {
  /** Any Claude model id. Categorizing is a small classification task: measure a cheaper tier with the eval. */
  model?: string;
  /** Defaults to the SDK's own credential resolution (`ANTHROPIC_API_KEY`, profiles, ...). */
  apiKey?: string;
  maxTokens?: number;
  /** Thinking depth and token spend. The default is the lowest level; raise it only if the eval says it pays. */
  effort?: "low" | "medium" | "high";
  /**
   * Ask the API to retry on a fallback model when a request is declined. Defaults to on for the
   * models that support it and off elsewhere.
   */
  refusalFallback?: boolean;
  /** Inject a preconfigured SDK client (tests, proxies). */
  client?: Anthropic;
}

/** Models that accept the server-side `fallbacks` parameter. */
export function supportsServerSideFallback(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable-5-[12])/.test(model);
}

export class ClaudeClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: "low" | "medium" | "high";
  private readonly refusalFallback: boolean;

  constructor(options: ClaudeClientOptions = {}) {
    this.client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.maxTokens = options.maxTokens ?? 16000;
    this.effort = options.effort ?? "low";
    this.refusalFallback = options.refusalFallback ?? supportsServerSideFallback(this.model);
  }

  async complete(messages: readonly LlmMessage[], options: LlmCallOptions = {}): Promise<LlmResult> {
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
      model: this.model,
      max_tokens: this.maxTokens,
      output_config: { effort: this.effort },
      // The system prompt (rules and the category list) is identical for every batch and the
      // transactions come after it, so it is the cacheable prefix. A prefix below the model's
      // minimum simply does not cache: check `cachedInputTokens` rather than assume.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: turns,
      // If a safety classifier declines the request, let the API re-run it on a fallback model
      // inside the same call instead of leaving the batch undecided.
      ...(this.refusalFallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
        },
        { signal: options.signal },
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

    // A refusal or a truncated reply arrives as HTTP 200. Check before reading the content.
    if (response.stop_reason === "refusal") {
      throw new LlmOutputError("the model declined to answer this batch");
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmOutputError("the model's reply was cut off at max_tokens");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      usage: {
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

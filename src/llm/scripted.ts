// A model that answers from a function. For tests, the offline demo and the offline eval.
//
// It makes one point concrete: what the agent guarantees does not depend on the model behaving.
// Script it to invent a category, to call a refund income or to answer with half a JSON document,
// and the same code decides what is written.

import { readGroups } from "../agent/prompt.js";
import type { PromptGroup } from "../agent/prompt.js";
import { ZERO_USAGE } from "./types.js";
import type { LlmCallOptions, LlmClient, LlmMessage, LlmResult, LlmUsage } from "./types.js";

/** Returns the reply for one request: an object to be serialised, or raw text to send as it is. */
export type Responder = (groups: PromptGroup[], messages: readonly LlmMessage[], call: number) => unknown;

export interface ScriptedOptions {
  model?: string;
  /** Usage to report per call, so cost arithmetic can be exercised without a provider. */
  usage?: LlmUsage;
}

export class ScriptedLlm implements LlmClient {
  /** Every request received, in order. Tests read this to assert on what the model was shown. */
  readonly calls: LlmMessage[][] = [];

  constructor(
    private readonly respond: Responder,
    private readonly options: ScriptedOptions = {},
  ) {}

  async complete(messages: readonly LlmMessage[], _options?: LlmCallOptions): Promise<LlmResult> {
    this.calls.push([...messages]);
    const user = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    const reply = await this.respond(readGroups(user), messages, this.calls.length);
    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage: this.options.usage ?? ZERO_USAGE,
      model: this.options.model ?? "scripted",
    };
  }

  /** Everything any request contained, joined. Handy for "this never reached the model" assertions. */
  transcript(): string {
    return this.calls.flat().map((message) => message.content).join("\n");
  }
}

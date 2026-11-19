import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { ClaudeClient } from "../src/llm/claude.js";
import { OpenAiCompatibleClient } from "../src/llm/openai-compatible.js";
import { LlmOutputError, LlmUnavailableError, extractJson, isUnavailableStatus } from "../src/llm/types.js";

const MESSAGES = [
  { role: "system" as const, content: "rules" },
  { role: "user" as const, content: "GROUPS" },
];

function claude(create: (body: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<unknown>) {
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return new ClaudeClient({ client, model: "claude-test" });
}

const reply = (extra: object = {}) => ({
  model: "claude-test-1",
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"decisions":[]}' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
  ...extra,
});

describe("ClaudeClient", () => {
  it("marks the system prompt as the cacheable prefix, passes the abort signal, and counts cached tokens as input", async () => {
    const seen: { body?: Record<string, unknown>; signal?: AbortSignal } = {};
    const signal = AbortSignal.timeout(60_000);
    const result = await claude(async (body, options) => {
      seen.body = body;
      seen.signal = options.signal;
      return reply();
    }).complete(MESSAGES, { signal });

    expect(seen.body?.system).toEqual([{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }]);
    expect(seen.body?.messages).toEqual([{ role: "user", content: "GROUPS" }]);
    expect(seen.signal).toBe(signal);
    expect(result).toEqual({ text: '{"decisions":[]}', model: "claude-test-1", usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 } });
  });

  it("reports a refusal or a truncated reply as unusable output", async () => {
    await expect(claude(async () => reply({ stop_reason: "refusal" })).complete(MESSAGES)).rejects.toBeInstanceOf(LlmOutputError);
    await expect(claude(async () => reply({ stop_reason: "max_tokens" })).complete(MESSAGES)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("maps rate limits, server errors and lost connections to 'unavailable', and lets a 400 through", async () => {
    const failing = (error: Error) =>
      claude(async () => {
        throw error;
      }).complete(MESSAGES);
    const apiError = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", new Headers());

    await expect(failing(apiError(429))).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(failing(apiError(529))).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(failing(new Anthropic.APIConnectionError({ message: "no route" }))).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(failing(new Anthropic.APIUserAbortError())).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(failing(apiError(400))).rejects.not.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("OpenAiCompatibleClient", () => {
  const client = (fetchImpl: typeof fetch) => new OpenAiCompatibleClient({ baseUrl: "https://llm.example.test/v1/", apiKey: "k", model: "m", fetchImpl });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("reads text and usage", async () => {
    let url = "";
    const result = await client(async (input) => {
      url = String(input);
      return json(200, { model: "m-1", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } });
    }).complete(MESSAGES);
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect(result).toEqual({ text: "{}", model: "m-1", usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } });
  });

  it("separates an outage from a caller's mistake", async () => {
    await expect(client(async () => json(503, {})).complete(MESSAGES)).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(client(async () => json(402, {})).complete(MESSAGES)).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(
      client(async () => {
        throw new TypeError("fetch failed");
      }).complete(MESSAGES),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    const badRequest = client(async () => json(400, { error: "bad" })).complete(MESSAGES);
    await expect(badRequest).rejects.toThrow(/400/);
    await expect(badRequest).rejects.not.toBeInstanceOf(LlmUnavailableError);
  });

  it("reports an empty or cut-off reply as unusable output", async () => {
    await expect(client(async () => json(200, { choices: [{ message: { content: "" } }] })).complete(MESSAGES)).rejects.toBeInstanceOf(LlmOutputError);
    await expect(client(async () => json(200, { choices: [{ message: { content: "{" }, finish_reason: "length" }] })).complete(MESSAGES)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe("helpers", () => {
  it("classifies statuses", () => {
    expect([401, 402, 403, 408, 429, 500, 503, 529].every(isUnavailableStatus)).toBe(true);
    expect([400, 404, 422].some(isUnavailableStatus)).toBe(false);
  });

  it("finds a JSON object in a chatty reply", () => {
    expect(extractJson('Sure: {"score": 4}')).toEqual({ score: 4 });
    expect(extractJson("nothing here")).toBeNull();
  });
});

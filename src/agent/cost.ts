// What a run cost.
//
// There are no prices in this file. Prices change, and a number written from memory is wrong
// sooner or later while still looking authoritative. You supply the table; a model that is not in
// it yields `null`, never an invented figure.

import type { LlmUsage } from "../llm/types.js";

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million input tokens read from the prompt cache. Defaults to the input price. */
  cachedInputPerMTok?: number;
}

/** Keyed by model id, or by a prefix of it (`"claude-haiku"` covers every dated variant). */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

export function priceFor(model: string, prices: PriceTable | undefined): ModelPrice | null {
  if (!prices) return null;
  let best: string | null = null;
  for (const key of Object.keys(prices)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : prices[best]!;
}

/**
 * Cost of some usage, in USD, or `null` when the model has no price.
 *
 * This is a floor, not an invoice. It does not include the surcharge some providers add for
 * writing to the prompt cache, nor any per-request fee. Reconcile against the provider's billing
 * before quoting it to anyone.
 */
export function estimateCost(usage: LlmUsage, model: string, prices: PriceTable | undefined): number | null {
  const price = priceFor(model, prices);
  if (!price) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return (fresh * price.inputPerMTok + cached * (price.cachedInputPerMTok ?? price.inputPerMTok) + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}

export function loadPriceTable(value: unknown): PriceTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("a price table is an object keyed by model id");
  const table: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    const price = entry as Partial<ModelPrice> | null;
    const numbers = [price?.inputPerMTok, price?.outputPerMTok, price?.cachedInputPerMTok ?? 0];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      throw new Error(`price table entry "${model}" needs non-negative inputPerMTok and outputPerMTok`);
    }
    table[model] = {
      inputPerMTok: price!.inputPerMTok!,
      outputPerMTok: price!.outputPerMTok!,
      ...(price!.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: price!.cachedInputPerMTok } : {}),
    };
  }
  return table;
}

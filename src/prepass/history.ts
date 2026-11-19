// Inheriting a category from the holder's own past.
//
// If the same counterparty was classified before, the cheapest and most accurate answer is the
// one already on file. The danger is the model agreeing with itself: an answer it gave last month
// becomes "history", is inherited, and is then counted as more history. The rules below are there
// to stop that loop.

import { signAllows } from "../core/taxonomy.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { Confidence, Direction, PastDecision } from "../core/types.js";
import type { Resolution } from "./transfers.js";

export interface HistoryOptions {
  /** `YYYY-MM-DD`. Ages are counted from here. */
  today: string;
  /** How long a model answer must have stood uncorrected before it counts. Default 7 days. */
  minAgeDays?: number;
}

interface Votes {
  manual: string[];
  model: string[];
  vetoed: boolean;
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface HistoryIndex {
  lookup(anchor: string, direction: Direction): Resolution | null;
}

/**
 * Builds the index. What counts as evidence:
 *
 * - a person's own choice, always;
 * - a model answer at high or medium confidence that has stood for `minAgeDays` without being
 *   corrected. Hosts are expected to drop or replace a `model` row when a person corrects it.
 *
 * What does not: low-confidence answers, the generic person buckets, categories that no longer
 * exist, and rows whose sign contradicts their category. For an individual (`person:` anchors),
 * only manual choices count. A transfer on file for the key vetoes it: the same counterparty being
 * a transfer once and an expense another time is exactly the case that needs a person.
 *
 * The answer must be unanimous, from at least two rows or one manual row. It is `high` only when
 * every row behind it was a person's choice.
 */
export function buildHistory(past: readonly PastDecision[], taxonomy: Taxonomy, options: HistoryOptions): HistoryIndex {
  const minAge = options.minAgeDays ?? 7;
  const generic = new Set([taxonomy.special.personSent, taxonomy.special.personReceived].filter(Boolean));
  const index = new Map<string, Votes>();

  for (const row of past) {
    const category = taxonomy.get(row.categoryId);
    if (!category || !signAllows(category.role, row.direction)) continue;
    const key = `${row.anchor}#${row.direction}`;
    const votes = index.get(key) ?? { manual: [], model: [], vetoed: false };
    index.set(key, votes);

    if (category.role === "transfer") {
      votes.vetoed = true;
      continue;
    }
    if (generic.has(category.id)) continue;
    if (row.source === "manual") {
      votes.manual.push(category.id);
      continue;
    }
    if (row.anchor.startsWith("person:")) continue;
    if (row.confidence !== "high" && row.confidence !== "medium") continue;
    if (daysBetween(row.decidedAt, options.today) < minAge) continue;
    votes.model.push(category.id);
  }

  return {
    lookup(anchor, direction) {
      const votes = index.get(`${anchor}#${direction}`);
      if (!votes || votes.vetoed) return null;
      const all = [...votes.manual, ...votes.model];
      if (votes.manual.length < 1 && all.length < 2) return null;
      const categoryId = all[0]!;
      if (all.some((id) => id !== categoryId)) return null;
      const confidence: Confidence = votes.model.length === 0 ? "high" : "medium";
      return {
        categoryId,
        confidence,
        stage: "history",
        reason: "Same counterparty and direction as earlier transactions that were classified this way.",
      };
    },
  };
}

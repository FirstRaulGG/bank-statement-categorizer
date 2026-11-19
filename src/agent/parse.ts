// Reading the model's reply without trusting it.
//
// Three things go wrong often enough to design for: the reply is cut off mid-document, one entry
// is malformed among forty good ones, and the model writes the right category name next to the
// wrong id. None of them should cost the whole batch.

import { z } from "zod";

import type { Taxonomy } from "../core/taxonomy.js";
import type { Confidence } from "../core/types.js";

export interface Proposal {
  key: string;
  categoryId: string;
  confidence: Confidence;
  reason: string;
}

export interface Dropped {
  key: string | null;
  why: string;
}

export interface ParseResult {
  proposals: Proposal[];
  dropped: Dropped[];
}

const Entry = z.object({
  key: z.string(),
  categoryId: z.string().nullish(),
  categoryName: z.string().nullish(),
  confidence: z.string().nullish(),
  reason: z.string().nullish(),
});

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Pulls every complete `{...}` out of the `decisions` array, one at a time. A reply that was cut
 * off after the thirtieth entry still yields thirty. Braces inside strings are not counted.
 */
function scanObjects(text: string): unknown[] {
  const label = text.indexOf('"decisions"');
  const start = text.indexOf("[", label === -1 ? 0 : label);
  if (start === -1) return [];

  const found: unknown[] = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) begin = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && begin !== -1) {
        try {
          found.push(JSON.parse(text.slice(begin, i + 1)));
        } catch {
          // a damaged entry; its neighbours are still good
        }
        begin = -1;
      }
      if (depth < 0) break;
    } else if (char === "]" && depth === 0) break;
  }
  return found;
}

function entriesOf(text: string): unknown[] {
  const body = stripFences(text);
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  for (const candidate of [body, first !== -1 && last > first ? body.slice(first, last + 1) : ""]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      const decisions = (parsed as { decisions?: unknown } | null)?.decisions;
      if (Array.isArray(decisions)) return decisions;
    } catch {
      // fall through to the scanner
    }
  }
  return scanObjects(body);
}

function confidenceOf(value: string | null | undefined): Confidence {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "high" || normalized === "medium" ? normalized : "low";
}

/**
 * Turns a reply into proposals for the groups that were actually asked about.
 *
 * Dropped, each on its own: entries that are not objects of the right shape, keys that were not in
 * the batch (the model cannot add groups), a second answer for the same key (the first stands),
 * an explicit `null` category (the model abstained), and categories that do not exist.
 *
 * Name and id are checked against each other. When they point at different categories the name
 * wins: models copy words more reliably than identifiers. When the id is valid but the name
 * matches nothing, the answer is kept at low confidence, since something was garbled.
 */
export function parseDecisions(text: string, keys: ReadonlySet<string>, taxonomy: Taxonomy): ParseResult {
  const proposals: Proposal[] = [];
  const dropped: Dropped[] = [];
  const seen = new Set<string>();

  for (const raw of entriesOf(text)) {
    const entry = Entry.safeParse(raw);
    if (!entry.success) {
      dropped.push({ key: null, why: "malformed entry" });
      continue;
    }
    const { key, categoryId, categoryName, confidence, reason } = entry.data;
    if (!keys.has(key)) {
      dropped.push({ key: null, why: "key not in the batch" });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ key, why: "duplicate answer" });
      continue;
    }
    seen.add(key);
    if (categoryId === null || categoryId === undefined) {
      dropped.push({ key, why: "the model abstained" });
      continue;
    }

    const byId = taxonomy.get(categoryId);
    const byName = categoryName ? taxonomy.findByName(categoryName) : undefined;
    const category = byName ?? byId;
    if (!category) {
      dropped.push({ key, why: "unknown category" });
      continue;
    }
    const garbled = Boolean(categoryName) && !byName;
    proposals.push({
      key,
      categoryId: category.id,
      confidence: garbled ? "low" : confidenceOf(confidence),
      reason: reason ?? "",
    });
  }
  return { proposals, dropped };
}

// Keyword rules: "this text means that category".
//
// A dictionary is fast, free and wrong in a particular way: most rules are always right and a few
// are right only sometimes ("POSTO" is fuel until it is a health post). So a rule is either
// `trusted`, and applied without asking anyone, or a hint the model sees and may overrule. The
// run report counts how often the model agreed with each hint, which is the evidence for
// promoting a rule to trusted or deleting it.

import { normalizeName, signAllows } from "../core/taxonomy.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { Confidence, Direction } from "../core/types.js";

export interface DictionaryRule {
  id: string;
  /** Text to find (compared without case or accents), or a regular expression source. */
  pattern: string;
  match?: "substring" | "regex";
  categoryId: string;
  /** Apply without consulting the model. Leave off until the rule has earned it. */
  trusted?: boolean;
}

interface Compiled {
  rule: DictionaryRule;
  order: number;
  find: RegExp;
  length: number;
  confidence: Confidence;
}

export interface DictionaryMatch {
  rule: DictionaryRule;
  confidence: Confidence;
}

export interface Dictionary {
  match(text: string, direction: Direction): DictionaryMatch | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validates and compiles the rules. A rule naming a category that does not exist, or carrying a
 * regular expression that does not compile, is a configuration error and throws here, at start-up.
 *
 * How a match is chosen:
 * - a pattern of four characters or fewer must stand as a word ("BAR" does not match "BARBEARIA");
 *   longer patterns match anywhere, so names the bank glued together are still found;
 * - a rule whose category disagrees with the direction of the money does not match at all;
 * - among the rules that match, the one found furthest to the left wins: in "POSTO ... FARMACIA"
 *   the line is about the first word. Ties go to the longer pattern, then to the earlier rule.
 */
export function compileDictionary(rules: readonly DictionaryRule[], taxonomy: Taxonomy): Dictionary {
  const ids = new Set<string>();
  const compiled: Compiled[] = rules.map((rule, order) => {
    if (ids.has(rule.id)) throw new Error(`duplicate dictionary rule id "${rule.id}"`);
    ids.add(rule.id);
    if (!taxonomy.get(rule.categoryId)) throw new Error(`dictionary rule "${rule.id}" names a category that does not exist: "${rule.categoryId}"`);
    if (rule.match === "regex") {
      return { rule, order, find: new RegExp(rule.pattern, "u"), length: rule.pattern.length, confidence: "medium" };
    }
    const pattern = normalizeName(rule.pattern);
    if (pattern.length < 2) throw new Error(`dictionary rule "${rule.id}" has a pattern shorter than two characters`);
    const short = pattern.length <= 4 && /^[A-Z0-9]+$/.test(pattern);
    const source = short ? String.raw`(?<![\p{L}\p{N}])${escapeRegExp(pattern)}(?![\p{L}\p{N}])` : escapeRegExp(pattern);
    return { rule, order, find: new RegExp(source, "u"), length: pattern.length, confidence: "high" };
  });

  return {
    match(text, direction) {
      let best: { item: Compiled; position: number } | null = null;
      for (const item of compiled) {
        const category = taxonomy.get(item.rule.categoryId)!;
        if (!signAllows(category.role, direction)) continue;
        const found = item.find.exec(text);
        if (!found) continue;
        const position = found.index;
        if (
          !best ||
          position < best.position ||
          (position === best.position && (item.length > best.item.length || (item.length === best.item.length && item.order < best.item.order)))
        ) {
          best = { item, position };
        }
      }
      return best ? { rule: best.item.rule, confidence: best.item.confidence } : null;
    },
  };
}

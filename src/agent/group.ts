// One question per counterparty, not one per line.
//
// Forty coffee purchases at the same place are one decision. Grouping makes the model's work (and
// the bill) proportional to the number of distinct counterparties instead of the number of rows.

import type { Rail } from "../core/clean.js";
import type { AccountKind, Direction } from "../core/types.js";
import type { DictionaryMatch } from "../prepass/dictionary.js";
import type { Prepared } from "./prepare.js";

export interface Group {
  /** Opaque handle (`g1`, `g2`, ...) used with the model. It carries nothing about the counterparty. */
  key: string;
  anchor: string;
  direction: Direction;
  items: Prepared[];
  /** Sum of absolute amounts, in cents. */
  totalCents: number;
  /** Cleaned description of the largest line. */
  text: string;
  rail: Rail | null;
  accountKind: AccountKind;
  /** In how many distinct calendar months the group appears. */
  months: number;
  person: boolean;
  /** Every line in the group says it is a refund or a reversal. */
  reversal: boolean;
  /** The lines name no counterparty. */
  unnamed: boolean;
  /** An untrusted dictionary match, shown to the model as a guess. */
  hint: DictionaryMatch | null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Groups by anchor, direction, kind of account, and whether the line is a reversal.
 *
 * - Direction: money from a counterparty and money to the same counterparty are different
 *   questions (a sale and its refund, a salary and a repayment).
 * - Reversal: a refund from an employer must not turn three salaries into refunds, and the
 *   salaries must not turn the refund into income.
 * - Kind of account: a credit on a card and a deposit in checking obey different rules.
 *
 * A line that names nobody has an anchor of its own (see `prepare`) and so is always alone.
 * Largest groups first, so that a run cut short has dealt with what matters most.
 */
export function buildGroups(items: readonly Prepared[]): Group[] {
  const byKey = new Map<string, Prepared[]>();
  for (const item of items) {
    const key = [item.anchor, item.direction, item.account.kind, item.reversal ? "r" : "", item.partition].join("#");
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }

  const groups = [...byKey.values()].map((list): Omit<Group, "key"> => {
    const largest = list.reduce((a, b) => (Math.abs(b.tx.amountCents) > Math.abs(a.tx.amountCents) ? b : a));
    return {
      anchor: largest.anchor,
      direction: largest.direction,
      items: list,
      totalCents: list.reduce((sum, item) => sum + Math.abs(item.tx.amountCents), 0),
      text: largest.text,
      rail: largest.rail,
      accountKind: largest.account.kind,
      months: new Set(list.map((item) => item.tx.date.slice(0, 7))).size,
      person: list.some((item) => item.person),
      reversal: largest.reversal,
      unnamed: largest.unnamed,
      hint: null,
    };
  });

  groups.sort((a, b) => b.totalCents - a.totalCents || compare(a.anchor, b.anchor) || compare(a.direction, b.direction) || compare(a.accountKind, b.accountKind) || Number(a.reversal) - Number(b.reversal));
  return groups.map((group, index) => ({ ...group, key: `g${index + 1}` }));
}

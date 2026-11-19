// The model proposes. This file decides.
//
// Every category the model suggests passes through `decide` before anything is written. The rules
// are few, and each one exists because the mistake it blocks is expensive and looks reasonable:
// a refund booked as income inflates what the person thinks they earn.

import { signAllows } from "../core/taxonomy.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { Group } from "./group.js";

export type Verdict =
  /** Write this category. `guard` is set when it is not the one the model proposed. */
  | { categoryId: string; guard?: string }
  /** Write nothing. A person decides. */
  | { categoryId: null; guard: string };

const REVERSAL = /\b(?:ESTORNO|ESTORNADO|REEMBOLSO|DEVOLUCAO|DEVOLVIDO|CHARGEBACK|CANCELAMENTO)\b/;

export function isReversal(group: Group): boolean {
  return group.items.some((item) => REVERSAL.test(item.raw));
}

/**
 * In order; the first rule that applies settles it.
 *
 * 1. `card_credit`: money credited to a card account is the bill or a reversal.
 * 2. `reversal_not_income`: a line that says it is a refund is not income, whatever the model
 *    thinks of the merchant. It goes to the refund category, or to review if there is none.
 * 3. `sign_mismatch`: income for money going out, or an expense for money coming in, is refused.
 * 4. `salary_needs_recurrence`: a deposit seen in a single month is not yet a salary.
 */
export function decide(group: Group, proposedId: string, taxonomy: Taxonomy): Verdict {
  const { special } = taxonomy;
  const proposed = taxonomy.get(proposedId);
  if (!proposed) return { categoryId: null, guard: "unknown_category" };

  if (group.accountKind === "card" && group.direction === "in") {
    return proposed.id === special.cardBill ? { categoryId: proposed.id } : { categoryId: special.cardBill, guard: "card_credit" };
  }

  if (proposed.role === "income" && isReversal(group)) {
    return special.refund ? { categoryId: special.refund, guard: "reversal_not_income" } : { categoryId: null, guard: "reversal_not_income" };
  }

  if (!signAllows(proposed.role, group.direction)) return { categoryId: null, guard: "sign_mismatch" };

  if (special.salary && proposed.id === special.salary && group.months < 2) {
    return { categoryId: special.otherIncome!, guard: "salary_needs_recurrence" };
  }

  return { categoryId: proposed.id };
}

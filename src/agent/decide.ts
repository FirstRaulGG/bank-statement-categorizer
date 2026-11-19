// The model proposes. This file decides.
//
// Every category the model suggests passes through `decide` before anything is written. The rules
// are few, and each one exists because the mistake it blocks is expensive and looks reasonable:
// a refund booked as income inflates what the person thinks they earn, and an expense booked as
// a transfer disappears from every total.

import { signAllows } from "../core/taxonomy.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { Group } from "./group.js";

export type Verdict =
  /** Write this category. `guard` is set when it is not the one the model proposed. */
  | { categoryId: string; guard?: string }
  /** Write nothing. A person decides. */
  | { categoryId: null; guard: string };

/**
 * Categories the model may answer with. Transfers, the card bill and the generic buckets for
 * individuals are decided by matching both sides of a movement or by rule, never by reading a
 * description. The refund category is offered, but `decide` only accepts it for a line that says
 * it is one.
 */
export function modelMayChoose(taxonomy: Taxonomy, categoryId: string): boolean {
  const category = taxonomy.get(categoryId);
  if (!category || category.role === "transfer") return false;
  const { special } = taxonomy;
  return ![special.ownTransfer, special.cardBill, special.personSent, special.personReceived].includes(category.id);
}

/**
 * In order; the first rule that applies settles it.
 *
 * 1. `card_credit`: money credited to a card account is the bill or a reversal.
 * 2. `not_for_the_model`: a transfer, the card bill or a generic bucket. Whatever the description
 *    says, including "this is a transfer between my accounts", the model's word is not enough.
 * 3. `reversal_not_income`: a line that says it is a refund is not income. It goes to the refund
 *    category, or to review if there is none.
 * 4. `refund_needs_reversal`: the refund category for a line that does not say it is a refund.
 * 5. `sign_mismatch`: income for money going out, or an expense for money coming in.
 * 6. `salary_needs_recurrence`: a deposit seen in a single month is not yet a salary.
 */
export function decide(group: Group, proposedId: string, taxonomy: Taxonomy): Verdict {
  const { special } = taxonomy;
  const proposed = taxonomy.get(proposedId);
  if (!proposed) return { categoryId: null, guard: "unknown_category" };

  if (group.accountKind === "card" && group.direction === "in") {
    return proposed.id === special.cardBill ? { categoryId: proposed.id } : { categoryId: special.cardBill, guard: "card_credit" };
  }

  if (!modelMayChoose(taxonomy, proposed.id)) return { categoryId: null, guard: "not_for_the_model" };

  if (proposed.role === "income" && group.reversal) {
    return special.refund ? { categoryId: special.refund, guard: "reversal_not_income" } : { categoryId: null, guard: "reversal_not_income" };
  }

  if (special.refund && proposed.id === special.refund && !group.reversal) return { categoryId: null, guard: "refund_needs_reversal" };

  if (!signAllows(proposed.role, group.direction)) return { categoryId: null, guard: "sign_mismatch" };

  if (special.salary && proposed.id === special.salary && group.months < 2) {
    return { categoryId: special.otherIncome!, guard: "salary_needs_recurrence" };
  }

  return { categoryId: proposed.id };
}

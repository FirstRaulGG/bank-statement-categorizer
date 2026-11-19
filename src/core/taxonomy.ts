// The list of categories, and the one rule every write obeys: the sign of the money has to agree
// with the kind of category.

import type { Direction } from "./types.js";

/**
 * - `income` only fits money coming in.
 * - `expense` only fits money going out.
 * - `transfer` is money moving between the holder's own accounts: neither income nor expense.
 * - `neutral` is anything else that should not count as either (a card bill being settled, a refund).
 */
export type Role = "income" | "expense" | "transfer" | "neutral";

export interface Category {
  /** Stable id, lower-case letters, digits and underscores. */
  id: string;
  name: string;
  role: Role;
  /** One line telling the model when this category applies. */
  hint?: string;
}

/** Categories the rules need to know by purpose. */
export interface SpecialCategories {
  /** Money between the holder's own accounts. Must have role `transfer`. */
  ownTransfer: string;
  /** A card bill being paid, seen from either account. Role `transfer` or `neutral`. */
  cardBill: string;
  /** Where a refund or reversal goes instead of income. Role `neutral`. Without it, such a row goes to review. */
  refund?: string;
  /** Generic bucket for money sent to an individual, when nothing is known about them. */
  personSent?: string;
  /** Generic bucket for money received from an individual. */
  personReceived?: string;
  /** The salary category. Needs `otherIncome`: a single deposit is not yet a salary. */
  salary?: string;
  otherIncome?: string;
}

export interface TaxonomySpec {
  categories: readonly Category[];
  special: SpecialCategories;
}

export interface Taxonomy {
  categories: readonly Category[];
  special: SpecialCategories;
  get(id: string): Category | undefined;
  /** Lookup by name, ignoring case, accents and spacing. */
  findByName(name: string): Category | undefined;
}

/** Upper case, no accents, single spaces. The form every comparison of names uses. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The sign rule. Every path that writes a category goes through it. */
export function signAllows(role: Role, direction: Direction): boolean {
  if (role === "income") return direction === "in";
  if (role === "expense") return direction === "out";
  return true;
}

export function defineTaxonomy(spec: TaxonomySpec): Taxonomy {
  const byId = new Map<string, Category>();
  const byName = new Map<string, Category>();
  for (const category of spec.categories) {
    if (!/^[a-z0-9_]+$/.test(category.id)) throw new Error(`category id "${category.id}" must be lower-case letters, digits and underscores`);
    if (byId.has(category.id)) throw new Error(`duplicate category id "${category.id}"`);
    const name = normalizeName(category.name);
    if (!name) throw new Error(`category "${category.id}" has no name`);
    if (byName.has(name)) throw new Error(`two categories are named "${category.name}"`);
    byId.set(category.id, category);
    byName.set(name, category);
  }

  const need = (label: keyof SpecialCategories, id: string | undefined, check: (category: Category) => boolean, rule: string) => {
    if (id === undefined) return;
    const category = byId.get(id);
    if (!category) throw new Error(`special.${label} names a category that does not exist: "${id}"`);
    if (!check(category)) throw new Error(`special.${label} ("${id}") ${rule}`);
  };
  const { special } = spec;
  need("ownTransfer", special.ownTransfer, (c) => c.role === "transfer", "must have role transfer");
  need("cardBill", special.cardBill, (c) => c.role === "transfer" || c.role === "neutral", "must have role transfer or neutral");
  need("refund", special.refund, (c) => c.role === "neutral", "must have role neutral");
  need("personSent", special.personSent, (c) => signAllows(c.role, "out"), "must accept money going out");
  need("personReceived", special.personReceived, (c) => signAllows(c.role, "in"), "must accept money coming in");
  need("salary", special.salary, (c) => c.role === "income", "must have role income");
  need("otherIncome", special.otherIncome, (c) => c.role === "income", "must have role income");
  if (special.salary && !special.otherIncome) throw new Error("special.salary needs special.otherIncome");

  return {
    categories: [...spec.categories],
    special: { ...special },
    get: (id) => byId.get(id),
    findByName: (name) => byName.get(normalizeName(name)),
  };
}

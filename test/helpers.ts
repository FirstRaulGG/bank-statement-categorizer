import { prepare } from "../src/agent/prepare.js";
import type { Prepared } from "../src/agent/prepare.js";
import { DEFAULT_TRADE_WORDS } from "../src/core/person.js";
import type { Account, Holder, Transaction } from "../src/core/types.js";
import { isValidCpf } from "../src/core/pii.js";

export const ACCOUNTS: Account[] = [
  { id: "chk", kind: "checking" },
  { id: "chk2", kind: "checking" },
  { id: "card", kind: "card" },
];

// Check digits deliberately wrong: these cannot be anybody's.
export const HOLDER_DOC = "123.456.789-00";
export const OTHER_DOC = "987.654.321-11";
export const HOLDER: Holder = { name: "Marina Albuquerque Prado", documents: [HOLDER_DOC] };

let counter = 0;
export function tx(description: string, amountCents: number, extra: Partial<Transaction> = {}): Transaction {
  counter += 1;
  return { id: `x${counter}`, accountId: "chk", date: "2026-03-10", amountCents, description, ...extra };
}

export function prepared(transactions: Transaction[]): Prepared[] {
  return prepare(transactions, ACCOUNTS, { tradeWords: new Set(DEFAULT_TRADE_WORDS) });
}

/** A CPF with correct check digits, found by search so that no real-looking literal sits in the repo. */
export function someValidCpf(base = "100200300"): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = base + String(suffix).padStart(2, "0");
    if (isValidCpf(candidate)) return candidate;
  }
  throw new Error("no valid suffix");
}

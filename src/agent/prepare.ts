// Everything derived from a transaction before any rule looks at it.

import { anchorOf, describeLine, detectRail } from "../core/clean.js";
import type { Rail } from "../core/clean.js";
import { looksLikePerson } from "../core/person.js";
import { normalizeName } from "../core/taxonomy.js";
import { directionOf } from "../core/types.js";
import type { Account, Direction, Transaction } from "../core/types.js";

export interface Prepared {
  tx: Transaction;
  account: Account;
  direction: Direction;
  /** The bank's line, upper case and without accents. Never sent anywhere. */
  raw: string;
  /** The cleaned description. */
  text: string;
  rail: Rail | null;
  anchor: string;
  /** The other side is, or may be, an individual. */
  person: boolean;
}

export interface PrepareOptions {
  tradeWords: ReadonlySet<string>;
  anchorSecret?: string;
}

export function prepare(transactions: readonly Transaction[], accounts: readonly Account[], options: PrepareOptions): Prepared[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const seen = new Set<string>();
  return transactions.map((tx) => {
    const account = byId.get(tx.accountId);
    if (!account) throw new Error(`transaction ${tx.id} names an account that was not supplied`);
    if (seen.has(tx.id)) throw new Error(`transaction id ${tx.id} appears twice`);
    seen.add(tx.id);
    if (!Number.isInteger(tx.amountCents)) throw new Error(`transaction ${tx.id}: amountCents must be an integer`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) throw new Error(`transaction ${tx.id}: date must be YYYY-MM-DD`);

    const raw = normalizeName(tx.description);
    const text = describeLine(tx.description, tx.counterparty);
    const rail = detectRail(raw);
    const anchor = anchorOf(text, raw, tx.counterparty, { anchorSecret: options.anchorSecret });
    const person = looksLikePerson({ text, rail, anchor, counterparty: tx.counterparty }, options.tradeWords);
    return { tx, account, direction: directionOf(tx.amountCents), raw, text, rail, anchor, person };
  });
}

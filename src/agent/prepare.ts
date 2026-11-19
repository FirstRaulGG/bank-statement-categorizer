// Everything derived from a transaction before any rule looks at it.

import { UNNAMED, anchorOf, describeLine, detectRail, isReversalLine, opaque } from "../core/clean.js";
import type { Rail } from "../core/clean.js";
import { looksLikePerson } from "../core/person.js";
import { plainForm } from "../core/pii.js";
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
  /** Stored by hosts as the key of a counterparty. Holds no document and no individual's name. */
  anchor: string;
  /** The other side is, or may be, an individual. */
  person: boolean;
  /** The line says it is a refund or a reversal. */
  reversal: boolean;
  /** The line names no counterparty at all. */
  unnamed: boolean;
  /** Extra key that keeps transactions apart when grouping. */
  partition: string;
}

export interface PrepareOptions {
  tradeWords: ReadonlySet<string>;
  anchorSecret?: string;
  partition?: (tx: Transaction) => string;
}

/** A bank line is short. Anything longer is cut before any pattern runs over it. */
const MAX_LINE = 400;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
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
    if (!isRealDate(tx.date)) throw new Error(`transaction ${tx.id}: date must be a real day written YYYY-MM-DD`);

    const description = plainForm(tx.description.slice(0, MAX_LINE));
    const counterparty = tx.counterparty?.name ? { ...tx.counterparty, name: plainForm(tx.counterparty.name.slice(0, MAX_LINE)) } : tx.counterparty;
    const raw = normalizeName(description);
    const text = describeLine(description, counterparty);
    const rail = detectRail(raw);
    let anchor = anchorOf(text, raw, counterparty, { anchorSecret: options.anchorSecret });
    const unnamed = anchor === UNNAMED;
    if (unnamed) anchor = `${UNNAMED}${tx.id}`;
    const person = !unnamed && looksLikePerson({ text, raw, rail, anchor, counterparty }, options.tradeWords);
    // A person without a document would otherwise be stored under their name.
    if (person && !anchor.startsWith("person:")) anchor = `person:${opaque(text, options.anchorSecret)}`;
    return {
      tx,
      account,
      direction: directionOf(tx.amountCents),
      raw,
      text,
      rail,
      anchor,
      person,
      reversal: isReversalLine(raw),
      unnamed,
      partition: options.partition?.(tx) ?? "",
    };
  });
}

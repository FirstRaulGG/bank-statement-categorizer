// Money that only changed pockets.
//
// Counted as spending and then again as income, a transfer between a person's own accounts ruins
// every total built on top. These passes find such movements from the data alone. No model is
// asked, and nothing here is a guess the model could talk its way around.

import { isTransferRail } from "../core/clean.js";
import { digitsOf } from "../core/pii.js";
import { similarNames } from "../core/person.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { Confidence, Holder, Stage } from "../core/types.js";
import type { Prepared } from "../agent/prepare.js";

export interface Resolution {
  categoryId: string;
  confidence: Confidence;
  stage: Stage;
  reason: string;
}

// Banks stamp the account holder's own document on lines that are not transfers at all.
const NOT_A_TRANSFER = /\b(?:SALARIO|PROVENTOS|FOLHA|REMUNERACAO|DIVIDENDOS?|RENDIMENTOS?|JUROS|TARIFA|RESGATE|APLICACAO)\b/;

/**
 * A line whose counterparty document is the holder's own, on a transfer rail.
 *
 * The rail is required. The document alone is not enough: fees, yields and salary can carry the
 * holder's document too, and calling those transfers hides real income and real cost. Only a CPF
 * counts. Money between a person and their own company is not a movement between their pockets.
 */
export function holderTransfers(items: readonly Prepared[], holder: Holder, taxonomy: Taxonomy): Map<string, Resolution> {
  const own = new Set(holder.documents.map((document) => digitsOf(document)).filter((digits) => digits.length === 11));
  const found = new Map<string, Resolution>();
  for (const item of items) {
    const document = digitsOf(item.tx.counterparty?.document);
    if (document.length !== 11 || !own.has(document)) continue;
    if (!isTransferRail(item.rail) || NOT_A_TRANSFER.test(item.raw)) continue;
    found.set(item.tx.id, {
      categoryId: taxonomy.special.ownTransfer,
      confidence: "high",
      stage: "holder_transfer",
      reason: "The counterparty document is the account holder's own, on a transfer rail.",
    });
  }
  return found;
}

const BILL_ON_CHECKING = /\b(?:FATURA|CARTAO)\b/;
const PAYMENT_ON_CARD = /\b(?:PAGAMENTO|PAGTO|PGTO)\b/;

function namesHolder(item: Prepared, holder: Holder): boolean {
  return similarNames(item.text, holder.name) || similarNames(item.tx.counterparty?.name ?? "", holder.name);
}

export interface TwinResult {
  resolutions: Map<string, Resolution>;
  /** Days on which the same amount moved more than once in the same direction. Left for later stages. */
  ambiguous: number;
}

/**
 * Opposite twins: the same amount leaving one account and entering another on the same day.
 *
 * - Checking to checking is an own transfer, but only with evidence that the holder is on the
 *   other side: one leg already settled as an own transfer, or a leg that names the holder while
 *   no leg names somebody else. Paying a friend and being paid the same sum by another friend on
 *   the same day is not a transfer.
 * - Money out of checking and into a card account is the card bill, when either line says so.
 *   A purchase on the card and a deposit in checking have the wrong directions and never match.
 *
 * Pairs are only formed when a day has exactly one candidate on each side. With two outflows of
 * the same amount there is no way to know which one the inflow belongs to, and a wrong pair hides
 * a real expense.
 *
 * `settled` holds transactions already resolved by an earlier pass. They can anchor a pair but
 * are never rewritten.
 */
export function oppositeTwins(items: readonly Prepared[], settled: ReadonlyMap<string, Resolution>, holder: Holder, taxonomy: Taxonomy): TwinResult {
  const buckets = new Map<string, { out: Prepared[]; in: Prepared[] }>();
  for (const item of items) {
    if (item.tx.amountCents === 0) continue;
    const key = `${item.tx.date}|${Math.abs(item.tx.amountCents)}`;
    const bucket = buckets.get(key) ?? { out: [], in: [] };
    bucket[item.direction].push(item);
    buckets.set(key, bucket);
  }

  const resolutions = new Map<string, Resolution>();
  let ambiguous = 0;
  const write = (item: Prepared, resolution: Resolution) => {
    if (!settled.has(item.tx.id)) resolutions.set(item.tx.id, resolution);
  };

  for (const bucket of buckets.values()) {
    if (!bucket.out.length || !bucket.in.length) continue;
    if (bucket.out.length > 1 || bucket.in.length > 1) {
      ambiguous += 1;
      continue;
    }
    const out = bucket.out[0]!;
    const into = bucket.in[0]!;
    if (out.account.id === into.account.id) continue;

    if (out.account.kind === "checking" && into.account.kind === "checking") {
      const anchored = [out, into].some((leg) => settled.get(leg.tx.id)?.categoryId === taxonomy.special.ownTransfer);
      const named = [out, into].some((leg) => namesHolder(leg, holder));
      const contradicted = [out, into].some((leg) => leg.person && !namesHolder(leg, holder) && !settled.has(leg.tx.id));
      if (!anchored && (!named || contradicted)) continue;
      const resolution: Resolution = {
        categoryId: taxonomy.special.ownTransfer,
        confidence: "high",
        stage: "twin",
        reason: "The same amount left one of the holder's accounts and entered another on the same day.",
      };
      write(out, resolution);
      write(into, resolution);
      continue;
    }

    if (out.account.kind === "checking" && into.account.kind === "card") {
      if (!BILL_ON_CHECKING.test(out.raw) && !PAYMENT_ON_CARD.test(into.raw)) continue;
      const resolution: Resolution = {
        categoryId: taxonomy.special.cardBill,
        confidence: "high",
        stage: "twin",
        reason: "The same amount left the checking account and was credited to the card account on the same day.",
      };
      write(out, resolution);
      write(into, resolution);
    }
  }
  return { resolutions, ambiguous };
}

/**
 * Money credited to a card account is the bill being settled or a purchase being reversed. Either
 * way it is not income, whatever the line says.
 */
export function cardCredits(items: readonly Prepared[], settled: ReadonlyMap<string, Resolution>, taxonomy: Taxonomy): Map<string, Resolution> {
  const found = new Map<string, Resolution>();
  for (const item of items) {
    if (settled.has(item.tx.id) || item.account.kind !== "card" || item.direction !== "in") continue;
    found.set(item.tx.id, {
      categoryId: taxonomy.special.cardBill,
      confidence: "high",
      stage: "card_credit",
      reason: "A credit on a card account is a payment or a reversal, never income.",
    });
  }
  return found;
}

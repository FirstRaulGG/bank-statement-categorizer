// The data the agent works on. Everything here is supplied by the host application.

export type AccountKind = "checking" | "card";

export interface Account {
  id: string;
  kind: AccountKind;
}

/** Who is on the other side, when the bank says so in a structured field. */
export interface Counterparty {
  name?: string;
  /** CPF (11 digits) or CNPJ (14 digits), with or without punctuation. */
  document?: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  /** Calendar day in the account's own time zone, `YYYY-MM-DD`. */
  date: string;
  /** Integer cents. Negative is money leaving the account. */
  amountCents: number;
  /** The line as the bank printed it. */
  description: string;
  counterparty?: Counterparty;
}

/** The person the accounts belong to. Used to recognise their own transfers, never sent to the model. */
export interface Holder {
  name: string;
  /** The holder's CPF, and a spouse's if money between them should count as an own transfer. */
  documents: readonly string[];
}

export type Direction = "in" | "out";
export type Confidence = "high" | "medium" | "low";

export const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Which part of the pipeline settled a transaction. Only `model` involved a model. */
export type Stage =
  | "holder_transfer"
  | "twin"
  | "card_credit"
  | "history"
  | "dictionary"
  | "person_bucket"
  | "model"
  | "none";

export type Status =
  /** A category was written. */
  | "applied"
  /** Nothing was written; `categoryId`, when present, is a suggestion for a person to confirm. */
  | "needs_review"
  /** Not looked at: the model was unavailable or time ran out. Safe to run again. */
  | "pending";

export interface Decision {
  transactionId: string;
  status: Status;
  categoryId: string | null;
  confidence: Confidence | null;
  stage: Stage;
  /** Fixed text for rule-based stages; the model's own words, cleaned, for `model`. */
  reason: string;
  /** The guard that changed or blocked the model's answer, if one did. */
  guard?: string;
  /** This transaction's share of what the model calls cost. Zero for rule-based stages. */
  costUsd: number | null;
}

/** A past classification the host stored, offered back as evidence. */
export interface PastDecision {
  /** The anchor the transaction had (see `prepare`). */
  anchor: string;
  direction: Direction;
  categoryId: string;
  /** `manual` is a person's choice. `model` is an answer of the model that nobody corrected. */
  source: "manual" | "model";
  confidence?: Confidence;
  /** `YYYY-MM-DD`. */
  decidedAt: string;
}

export function directionOf(amountCents: number): Direction {
  return amountCents < 0 ? "out" : "in";
}

/** `123456` -> `"1234.56"`. Integer arithmetic only. */
export function formatCents(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole}.${fraction}`;
}

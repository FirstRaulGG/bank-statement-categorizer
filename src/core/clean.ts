// Turning a statement line into something that can be compared with another statement line.
//
// "PIX ENVIADO - PADARIA TRIGO DOURADO 03/05" and "COMPRA CARTAO PADARIA TRIGO DOURADO CAMPINAS BR"
// are the same merchant. Cleaning strips what the bank added (the operation label in front, the
// codes and places behind) and derives an anchor: the short key that groups a merchant's lines.

import { createHash, createHmac } from "node:crypto";

import { digitsOf, isValidCnpj, plainForm, scrub } from "./pii.js";
import { normalizeName } from "./taxonomy.js";
import type { Counterparty } from "./types.js";

export type Rail = "pix" | "ted" | "doc" | "transfer" | "boleto" | "debit" | "card";

/** How the money moved, read from the bank's own wording. `null` when the line does not say. */
export function detectRail(normalizedRaw: string): Rail | null {
  if (/\bPIX\b/.test(normalizedRaw)) return "pix";
  if (/\bTED\b/.test(normalizedRaw)) return "ted";
  if (/\bDOC\b/.test(normalizedRaw)) return "doc";
  if (/\b(?:TRANSF|TEF\b)/.test(normalizedRaw)) return "transfer";
  if (/\b(?:BOLETO|TITULO)\b/.test(normalizedRaw)) return "boleto";
  if (/\bDEB(?:ITO)?\s+AUT/.test(normalizedRaw)) return "debit";
  if (/\b(?:COMPRA|CARTAO)\b/.test(normalizedRaw)) return "card";
  return null;
}

/** Rails a person uses to send money to another person or to themselves. */
export function isTransferRail(rail: Rail | null): boolean {
  return rail === "pix" || rail === "ted" || rail === "doc" || rail === "transfer";
}

// What banks put in front of the name. Applied repeatedly, because labels stack.
const PREFIXES: readonly RegExp[] = [
  /^(?:PIX|TED|DOC|TEF)\s+(?:ENVIAD[OA]|RECEBID[OA]|TRANSF(?:ERENCIA)?|QR\s?CODE|QRS?|EMITID[OA]|CRED(?:ITO)?|DEB(?:ITO)?)\b[\s:–-]*/,
  /^TRANSF(?:ERENCIA)?\s+(?:ENVIADA|RECEBIDA|PIX|ENTRE\s+CONTAS)\b[\s:–-]*/,
  /^(?:PIX|TED|DOC)\/(?:PIX|TED|DOC)\b[\s:/-]*/,
  /^(?:ENVIAD[OA]|RECEBID[OA])\b[\s:/-]*/,
  /^TRANSF(?:ERENCIA)?\b[\s:–-]*/,
  /^COMPRAS?\s+(?:(?:NO|COM)\s+)?(?:CARTAO|DEBITO|CREDITO)(?:\s+(?:DE\s+)?(?:DEBITO|CREDITO))?\b[\s:–-]*/,
  /^COMPRAS?\b[\s:–-]+/,
  /^(?:PAGTO|PAGAMENTO|PGTO|PAG)\s+(?:DE\s+)?(?:BOLETO|TITULO|CONTA|COBRANCA)\b[\s:–-]*/,
  /^DEB(?:ITO)?\s+AUT(?:OMATICO)?\b[\s:–-]*/,
  /^(?:PIX|TED|DOC)\b[\s:–-]*/,
  // A payment processor's tag: two or three characters and an asterisk in front of the real
  // merchant. Anything longer before the asterisk is as likely to be the merchant's own name.
  /^[A-Z0-9]{2,3}\s?\*\s?/,
  /^[\s:*–-]+/,
];

// What banks put behind it.
const SUFFIXES: readonly RegExp[] = [
  /\s+(?:PARC(?:ELA)?\s*)?\d{1,2}\s?\/\s?\d{1,2}$/,
  /\s+\d{2}\/\d{2}(?:\/\d{2,4})?$/,
  /\s+\d{2}:\d{2}(?::\d{2})?$/,
  // A place is only cut when a country marker confirms it is one; a shop can be named after a city.
  /\s+[A-Z]{3,}\s+BRA?$/,
  /\s+BRA?$/,
  /\s+\d{6,}$/,
  /[\s:*–-]+$/,
];

const MAX_PASSES = 5;

function strip(text: string, rules: readonly RegExp[]): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let next = current;
    for (const rule of rules) {
      const candidate = next.replace(rule, "").trim();
      // A rule that would leave nothing behind was wrong about this line.
      if (candidate.length >= 2) next = candidate;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Upper case, no accents, no bank labels, no trailing codes. */
export function cleanDescription(raw: string): string {
  const normalized = normalizeName(plainForm(raw).replace(/\|/g, " "));
  return strip(strip(normalized, PREFIXES), SUFFIXES).replace(/\*/g, " ").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "EM", "NO", "NA", "LTDA", "ME", "SA", "EIRELI", "EPP", "MEI", "CIA"]);

// Words that say how the money moved, not who it went to. A line made only of these names nobody.
const LABELS = new Set([
  "PIX", "TED", "DOC", "TEF", "TRANSF", "TRANSFERENCIA", "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA", "BOLETO", "TITULO",
  "PAGTO", "PAGAMENTO", "PGTO", "PAG", "COMPRA", "COMPRAS", "CARTAO", "DEBITO", "CREDITO", "DEB", "CRED", "AUT", "AUTOMATICO",
  "SAQUE", "DEPOSITO", "QR", "CODE", "CPF", "CNPJ",
]);

/** Prefix of the anchor given to a line that names no counterparty. Such lines are never grouped. */
export const UNNAMED = "unnamed:";

/** Hash that stands in for something that must not be stored as it is. Keyed when a secret is given. */
export function opaque(value: string, secret?: string): string {
  const hash = secret ? createHmac("sha256", secret).update(value).digest("hex") : createHash("sha256").update(value).digest("hex");
  return hash.slice(0, 16);
}

// Written with its punctuation, a company id is unmistakable. As a bare run of 14 digits it is only
// taken for one when the check digits agree: boleto and authentication codes are that long too.
const CNPJ_PUNCTUATED = /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/;
const FOURTEEN_DIGITS = /(?<!\d)\d{14}(?!\d)/g;

function companyIdIn(raw: string): string | null {
  const punctuated = CNPJ_PUNCTUATED.exec(raw);
  if (punctuated) return digitsOf(punctuated[0]);
  return raw.match(FOURTEEN_DIGITS)?.find((run) => isValidCnpj(run)) ?? null;
}

export interface AnchorOptions {
  /**
   * Key for the hash that stands in for an individual's CPF. Without it the hash is unkeyed, and
   * anyone holding your stored anchors can recover the CPFs by trying all of them.
   */
  anchorSecret?: string;
}

/**
 * The key that groups a counterparty's lines.
 *
 * - A company id (CNPJ), when the line or the bank's structured field has one: `cnpj:<14 digits>`.
 * - An individual's CPF from the structured field, hashed: `person:<hash>`. The number itself is
 *   never part of an anchor.
 * - Otherwise the first two meaningful words of the cleaned text, or `unnamed:` when there are
 *   none. `prepare` completes that one with the transaction id, and replaces the anchor of anyone
 *   who looks like an individual with a hash of their name.
 */
export function anchorOf(cleaned: string, raw: string, counterparty: Counterparty | undefined, options: AnchorOptions = {}): string {
  const document = digitsOf(counterparty?.document);
  if (document.length === 14) return `cnpj:${document}`;
  if (document.length === 11) return `person:${opaque(document, options.anchorSecret)}`;
  const inText = companyIdIn(raw);
  if (inText) return `cnpj:${inText}`;

  // An anchor is stored, so it is built from the scrubbed text: no CPF, phone, e-mail or code can
  // become part of one.
  const words: string[] = [];
  for (const token of scrub(cleaned, { maskCompanyIds: true }).split(" ")) {
    if (token.includes("[") || token.includes("]")) continue;
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!word || STOPWORDS.has(word) || LABELS.has(word) || /^\d+$/.test(word) || /\d{4,}/.test(word)) continue;
    words.push(word);
    if (words.length === 2) break;
  }
  return words.join(" ") || UNNAMED;
}

/** The best text to read a counterparty from: the bank's structured name when the line itself has none. */
export function describeLine(raw: string, counterparty: Counterparty | undefined): string {
  const cleaned = cleanDescription(raw);
  const name = counterparty?.name ? cleanDescription(counterparty.name) : "";
  // A line that is only an operation label ("PIX ENVIADO") cleans down to that label or to digits.
  const empty = !/\p{L}{3,}/u.test(cleaned) || /^(?:(?:PIX|TED|DOC|TEF|TRANSF(?:ERENCIA)?|PAGAMENTO|PAGTO|COMPRA|ENVIAD[OA]|RECEBID[OA])\s*)+$/.test(cleaned);
  return empty && name ? name : cleaned;
}

const REVERSAL = /(?<!\p{L})(?:ESTORNO|ESTORNADO|REEMBOLSO|DEVOLUCAO|DEVOLVIDO|CHARGEBACK|CANCELAMENTO)(?!\p{L})/u;

/** Whether a normalised line says it is money coming back: a refund, a reversal, a chargeback. */
export function isReversalLine(normalizedRaw: string): boolean {
  return REVERSAL.test(normalizedRaw);
}

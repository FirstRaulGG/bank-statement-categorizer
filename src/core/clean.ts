// Turning a statement line into something that can be compared with another statement line.
//
// "PIX ENVIADO - PADARIA TRIGO DOURADO 03/05" and "COMPRA CARTAO PADARIA TRIGO DOURADO CAMPINAS BR"
// are the same merchant. Cleaning strips what the bank added (the operation label in front, the
// codes and places behind) and derives an anchor: the short key that groups a merchant's lines.

import { createHash, createHmac } from "node:crypto";

import { digitsOf, isValidCnpj } from "./pii.js";
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
  /^TRANSF(?:ERENCIA)?\b[\s:–-]*/,
  /^COMPRAS?\s+(?:(?:NO|COM)\s+)?(?:CARTAO|DEBITO|CREDITO)(?:\s+(?:DE\s+)?(?:DEBITO|CREDITO))?\b[\s:–-]*/,
  /^COMPRAS?\b[\s:–-]+/,
  /^(?:PAGTO|PAGAMENTO|PGTO|PAG)\s+(?:DE\s+)?(?:BOLETO|TITULO|CONTA|COBRANCA)\b[\s:–-]*/,
  /^DEB(?:ITO)?\s+AUT(?:OMATICO)?\b[\s:–-]*/,
  /^(?:PIX|TED|DOC)\b[\s:–-]*/,
  // A payment processor's tag: a few characters and an asterisk in front of the real merchant.
  /^[A-Z0-9]{2,8}\s?\*\s?/,
  /^[\s:*–-]+/,
];

// What banks put behind it.
const SUFFIXES: readonly RegExp[] = [
  /\s+(?:PARC(?:ELA)?\s*)?\d{1,2}\s?\/\s?\d{1,2}$/,
  /\s+\d{2}\/\d{2}(?:\/\d{2,4})?$/,
  /\s+\d{2}:\d{2}(?::\d{2})?$/,
  // A place is only cut when a country marker confirms it is one; a shop can be named after a city.
  /\s+[A-Z]+\s+(?:BRA?|BRASIL)$/,
  /\s+(?:BRA?|BRASIL)$/,
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
  const normalized = normalizeName(raw.replace(/\|/g, " "));
  return strip(strip(normalized, PREFIXES), SUFFIXES).replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "EM", "NO", "NA", "LTDA", "ME", "SA", "EIRELI", "EPP", "MEI", "CIA"]);

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
 * - Otherwise the first two meaningful words of the cleaned text.
 */
export function anchorOf(cleaned: string, raw: string, counterparty: Counterparty | undefined, options: AnchorOptions = {}): string {
  const document = digitsOf(counterparty?.document);
  if (document.length === 14) return `cnpj:${document}`;
  if (document.length === 11) {
    const hash = options.anchorSecret
      ? createHmac("sha256", options.anchorSecret).update(document).digest("hex")
      : createHash("sha256").update(document).digest("hex");
    return `person:${hash.slice(0, 16)}`;
  }
  const inText = companyIdIn(raw);
  if (inText) return `cnpj:${inText}`;

  const words: string[] = [];
  for (const token of cleaned.split(" ")) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    // Codes, phone numbers and e-mail keys are not names, and an anchor is stored.
    if (!word || STOPWORDS.has(word) || /\d{4,}/.test(word) || /^\d+$/.test(word) || /[@[\]]/.test(word)) continue;
    words.push(word);
    if (words.length === 2) break;
  }
  return words.join(" ") || "UNKNOWN";
}

/** The best text to read a counterparty from: the bank's structured name when the line itself has none. */
export function describeLine(raw: string, counterparty: Counterparty | undefined): string {
  const cleaned = cleanDescription(raw);
  const name = counterparty?.name ? cleanDescription(counterparty.name) : "";
  // A line that is only an operation label ("PIX ENVIADO") cleans down to that label or to digits.
  const empty = !/\p{L}{3,}/u.test(cleaned) || /^(?:(?:PIX|TED|DOC|TEF|TRANSF(?:ERENCIA)?|PAGAMENTO|PAGTO|COMPRA|ENVIAD[OA]|RECEBID[OA])\s*)+$/.test(cleaned);
  return empty && name ? name : cleaned;
}

// Telling a person from a business, and one person's name from another's.
//
// This decides what the model is allowed to see. A payment to an individual says nothing about
// what it was for: the same person is rent one month and a birthday present the next. Sending it
// to a model buys a guess and costs a third party's name. So such lines are kept back.
//
// It is a best effort. With a CPF in sight the answer is exact. Without one it is a guess from the
// shape of the text, and a guess can be wrong in both directions.

import { isTransferRail } from "./clean.js";
import type { Rail } from "./clean.js";
import { digitsOf, mentionsCpf } from "./pii.js";
import { normalizeName } from "./taxonomy.js";
import type { Counterparty } from "./types.js";

const COMPANY_MARKERS = new Set([
  "LTDA", "EIRELI", "EPP", "MEI", "CIA", "COMERCIO", "SERVICOS", "INDUSTRIA", "ASSOCIACAO", "INSTITUTO",
  "BANCO", "COOPERATIVA", "CONDOMINIO", "IGREJA", "PREFEITURA", "SECRETARIA", "MINISTERIO", "FUNDACAO", "SINDICATO",
]);
// "ME" and "SA" mark a company only at the very end of a name. Elsewhere "SA" is a surname.
const TRAILING_MARKERS = new Set(["ME", "SA"]);
const PARTICLES = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);

/** Words that open a shop's name far more often than a person's. Extend it for your own data. */
export const DEFAULT_TRADE_WORDS: readonly string[] = [
  "PADARIA", "MERCADO", "SUPERMERCADO", "MERCEARIA", "FARMACIA", "DROGARIA", "POSTO", "RESTAURANTE", "LANCHONETE",
  "PIZZARIA", "BAR", "LOJA", "ACADEMIA", "CLINICA", "HOSPITAL", "LABORATORIO", "ESCOLA", "COLEGIO", "FACULDADE",
  "LIVRARIA", "PAPELARIA", "OFICINA", "AUTO", "PET", "HOTEL", "POUSADA", "SALAO", "BARBEARIA", "ACOUGUE",
  "HORTIFRUTI", "EMPORIO", "CAFE", "CAFETERIA", "STUDIO", "ESTACIONAMENTO", "TRANSPORTES", "SEGUROS", "ENERGIA",
  "TELECOM", "INTERNET", "AGUA", "GAS", "DISTRIBUIDORA", "ATACADO", "MAGAZINE", "OTICA", "FLORICULTURA",
  "IMOBILIARIA", "AGENCIA", "ATELIE", "ESTUDIO", "CINE", "TEATRO", "COMPANHIA",
];

export interface PersonCheck {
  /** Cleaned description. */
  text: string;
  /** The bank's line, normalised. */
  raw: string;
  rail: Rail | null;
  anchor: string;
  counterparty?: Counterparty;
}

/**
 * True when the other side is, or may well be, an individual.
 *
 * Exact cases:
 * - the bank's structured document has 11 digits (a person) or 14 (a company);
 * - a CPF, whole or half-masked, is printed anywhere in the line or in the counterparty's name.
 *
 * Otherwise a guess, made only on a person-to-person rail (Pix, TED, DOC, transfer): two to eight
 * words that are all name-like (letters, with an apostrophe, hyphen or abbreviation dot allowed),
 * with no company marker and no trade word, are taken to be a name.
 *
 * Known misses, both ways:
 * - a shop with a plain two-word name paid by Pix is taken for a person, and goes to a generic
 *   bucket or to review instead of to the model;
 * - a person paid by boleto or card, or printed as a single name, or on a line that does not say
 *   how the money moved, is NOT recognised, and the line goes to the model with the name in it.
 */
export function looksLikePerson(check: PersonCheck, tradeWords: ReadonlySet<string>): boolean {
  const document = digitsOf(check.counterparty?.document);
  if (document.length === 11) return true;
  if (document.length === 14 || check.anchor.startsWith("cnpj:")) return false;
  if (mentionsCpf(check.raw) || mentionsCpf(check.counterparty?.name)) return true;
  if (!isTransferRail(check.rail)) return false;

  const words = check.text.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  return words.every((word, index) => {
    if (!/^\p{L}[\p{L}'’.-]*$/u.test(word)) return false;
    if (PARTICLES.has(word)) return true;
    if (word.replace(/[^\p{L}]/gu, "").length < 2 && !/^\p{L}\.?$/u.test(word)) return false;
    if (COMPANY_MARKERS.has(word) || tradeWords.has(word)) return false;
    const last = index === words.length - 1;
    const afterParticle = PARTICLES.has(words[index - 1] ?? "");
    return !(TRAILING_MARKERS.has(word) && last && !afterParticle);
  });
}

const NAME_NOISE = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "PIX", "TED", "DOC", "TRANSF", "TRANSFERENCIA", "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA"]);

function nameTokens(value: string): string[] {
  return normalizeName(value)
    .split(/[\s-]+/)
    .map((token) => token.replace(/[^\p{L}]/gu, ""))
    .filter((token) => token && !NAME_NOISE.has(token));
}

/**
 * Whether two printed names plausibly belong to the same person. The first names must be equal.
 * Beyond that, one of them may be a first name alone, or they must share another name, an initial
 * counting for the name it starts. Same surname with a different first name is a relative, not a match.
 */
export function similarNames(a: string, b: string): boolean {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length || left[0] !== right[0]) return false;
  if (left.length === 1 || right.length === 1) return true;
  const restLeft = left.slice(1);
  const restRight = right.slice(1);
  return restLeft.some((x) => restRight.some((y) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))));
}

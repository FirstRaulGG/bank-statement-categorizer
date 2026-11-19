// Telling a person from a business, and one person's name from another's.
//
// This decides what the model is allowed to see. A payment to an individual says nothing about
// what it was for: the same person is rent one month and a birthday present the next. Sending it
// to a model buys a guess and costs a third party's name. So such lines never go.

import { digitsOf } from "./pii.js";
import { isTransferRail } from "./clean.js";
import type { Rail } from "./clean.js";
import { normalizeName } from "./taxonomy.js";
import type { Counterparty } from "./types.js";

const COMPANY_MARKERS = new Set([
  "LTDA", "ME", "SA", "EIRELI", "EPP", "MEI", "CIA", "COMERCIO", "SERVICOS", "INDUSTRIA", "ASSOCIACAO", "INSTITUTO",
  "BANCO", "COOPERATIVA", "CONDOMINIO", "IGREJA", "PREFEITURA", "SECRETARIA", "MINISTERIO", "FUNDACAO", "SINDICATO",
]);

/** Words that open a shop's name far more often than a person's. Extend it for your own data. */
export const DEFAULT_TRADE_WORDS: readonly string[] = [
  "PADARIA", "MERCADO", "SUPERMERCADO", "MERCEARIA", "FARMACIA", "DROGARIA", "POSTO", "RESTAURANTE", "LANCHONETE",
  "PIZZARIA", "BAR", "LOJA", "ACADEMIA", "CLINICA", "HOSPITAL", "LABORATORIO", "ESCOLA", "COLEGIO", "FACULDADE",
  "LIVRARIA", "PAPELARIA", "OFICINA", "AUTO", "PET", "HOTEL", "POUSADA", "SALAO", "BARBEARIA", "ACOUGUE",
  "HORTIFRUTI", "EMPORIO", "CAFE", "CAFETERIA", "STUDIO", "ESTACIONAMENTO", "TRANSPORTES", "SEGUROS", "ENERGIA",
  "TELECOM", "INTERNET", "AGUA", "GAS", "DISTRIBUIDORA", "ATACADO", "MAGAZINE", "OTICA", "FLORICULTURA",
];

export interface PersonCheck {
  /** Cleaned description. */
  text: string;
  rail: Rail | null;
  anchor: string;
  counterparty?: Counterparty;
}

/**
 * True when the other side is, or may well be, an individual.
 *
 * With a document the answer is exact: 11 digits is a person, 14 is a company. Without one it is
 * a guess that leans towards "person": on a person-to-person rail, two to five plain words with no
 * company marker and no trade word are taken to be a name. A two-word shop paid by Pix can be
 * caught by this. That is the intended direction of the error: the line goes to a generic bucket
 * or to review instead of to the model.
 */
export function looksLikePerson(check: PersonCheck, tradeWords: ReadonlySet<string>): boolean {
  const document = digitsOf(check.counterparty?.document);
  if (document.length === 11) return true;
  if (document.length === 14 || check.anchor.startsWith("cnpj:")) return false;
  if (!isTransferRail(check.rail)) return false;

  const words = check.text.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) => /^\p{L}{2,}$/u.test(word) && !COMPANY_MARKERS.has(word) && !tradeWords.has(word));
}

const NAME_NOISE = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "PIX", "TED", "DOC", "TRANSF", "TRANSFERENCIA", "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA"]);

function nameTokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
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

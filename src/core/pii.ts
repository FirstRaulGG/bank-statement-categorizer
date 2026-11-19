// What is removed from a line before a model may read it.
//
// A bank statement is full of other people's identifiers: the CPF of whoever you paid, the phone
// number or e-mail used as a Pix key, account numbers, authentication codes. None of it helps to
// decide a category. `scrub` replaces each with a placeholder that still says what was there.
//
// Names are a different problem, and a pattern cannot solve it. They are handled by structure
// instead: a payment to an individual is never sent to the model at all (see `core/person.ts`).

export function digitsOf(value: string | undefined | null): string {
  return (value ?? "").replace(/\D/g, "");
}

function allSame(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function checkDigit(digits: string, weights: readonly number[]): number {
  let sum = 0;
  weights.forEach((weight, index) => {
    sum += Number(digits[index]) * weight;
  });
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** True when the 11 digits carry correct check digits. Says nothing about whether the number was ever issued. */
export function isValidCpf(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 11 || allSame(digits)) return false;
  const first = checkDigit(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(digits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(digits[9]) && second === Number(digits[10]);
}

/** True when the 14 digits carry correct check digits. */
export function isValidCnpj(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 14 || allSame(digits)) return false;
  const first = checkDigit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(digits[12]) && second === Number(digits[13]);
}

export function formatCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

// A digit or one of the characters banks print in place of a hidden digit.
const M = String.raw`[\d*•xX]`;
const EDGE = String.raw`[\p{L}\p{N}*•]`;

// One alternation, tried left to right at each position, so the more specific shape wins.
const IDENTIFIERS = new RegExp(
  [
    String.raw`(?<email>(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+)`,
    // A random Pix key is a UUID.
    String.raw`(?<key>\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)`,
    String.raw`(?<cnpj>(?<!\d)\d{2}\.?\d{3}\.?\d{3}/\d{4}-?\d{2}(?!\d))`,
    // Three, three, three and two, however they are separated, and however much is masked:
    // 123.456.789-00, 12345678900, 123 456 789 00, ***.456.789-**, •••.456.789-••.
    String.raw`(?<cpf>(?<!${EDGE})${M}{3}[\s.]?${M}{3}[\s.]?${M}{3}\s?[-.\s]?\s?${M}{2}(?!${EDGE}))`,
    String.raw`(?<phone>(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?[\s.-]?\d{4}[\s.-]\d{4}(?!\d))`,
    // Two long runs side by side are one identifier printed with a gap.
    String.raw`(?<split>(?<!\d)\d{4,}\s\d{4,}(?!\d))`,
    String.raw`(?<run>(?<!\d)\d(?:[.\-/]?\d){6,}(?!\d))`,
  ].join("|"),
  "giu",
);

const MINUS = String.fromCodePoint(0x2212);
const DASHES = new RegExp(String.raw`[\p{Pd}${MINUS}]`, "gu");

function asciiDigit(char: string): string {
  const code = char.codePointAt(0)!;
  if (code < 128) return char;
  // Decimal digits of every script sit in runs of ten, zero first.
  let value = 0;
  while (value < 9 && /\p{Nd}/u.test(String.fromCodePoint(code - value - 1))) value += 1;
  return String(value);
}

/**
 * One spelling for what can be spelled many ways: fullwidth and other compatibility forms folded,
 * every kind of dash turned into a hyphen, digits of any script turned into 0-9. Without this a
 * CPF written with a non-breaking hyphen walks past every pattern.
 */
export function plainForm(text: string): string {
  return text.normalize("NFKC").replace(DASHES, "-").replace(/\p{Nd}/gu, asciiDigit);
}

export interface ScrubOptions {
  /**
   * Replace company ids (CNPJ) too. Off by default: a CNPJ is public registry data and is often
   * the only thing that identifies a merchant.
   */
  maskCompanyIds?: boolean;
}

/**
 * Replaces identifiers with placeholders: `[email]`, `[key]`, `[cpf]`, `[phone]`, `[number]`, and
 * `[cnpj]` when asked.
 *
 * It matches on shape, not on validity. An 11-digit run is treated as a CPF whether or not its
 * check digits are right: a wrong guess costs a placeholder, a missed one leaks a person. It is
 * blunt in the same direction elsewhere: a date or a long amount in the middle of a line becomes
 * `[number]` too.
 *
 * It is a net, not a proof. A format nobody thought of gets through. The text is returned in its
 * plain form (see `plainForm`).
 */
export function scrub(text: string, options: ScrubOptions = {}): string {
  return plainForm(text).replace(IDENTIFIERS, (match, ...rest) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    if (groups.email) return "[email]";
    if (groups.key) return "[key]";
    if (groups.cnpj) return options.maskCompanyIds ? "[cnpj]" : match;
    if (groups.cpf) return "[cpf]";
    if (groups.phone) return "[phone]";
    if (groups.split) return "[number]";
    const digits = digitsOf(match);
    if (digits.length === 11) return "[cpf]";
    // A bare 14-digit run is kept only if it really is a company id; otherwise it is some code.
    if (digits.length === 14 && isValidCnpj(digits)) return options.maskCompanyIds ? "[cnpj]" : match;
    return "[number]";
  });
}

/** Whether the text carries anything shaped like a CPF, whole or half-masked. */
export function mentionsCpf(text: string | undefined): boolean {
  if (!text) return false;
  const plain = plainForm(text);
  const labelled = /(?<!\p{L})CPF(?!\p{L})/iu.test(plain);
  for (const match of plain.matchAll(CPF_SHAPE)) {
    // Eleven bare digits could as well be a phone number or a code. Punctuation, a mask or the
    // word "CPF" beside them is what makes them a CPF.
    if (labelled || /\D/.test(match[0])) return true;
  }
  return false;
}

const CPF_SHAPE = new RegExp(String.raw`(?<!${EDGE})${M}{3}[\s.]?${M}{3}[\s.]?${M}{3}\s?[-.\s]?\s?${M}{2}(?!${EDGE})`, "gu");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PARTICLES = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);

/**
 * Replaces a person's name in a text. `normalizedName` is upper case without accents; the text may
 * be in any case, and comes back without accents.
 *
 * What is replaced is a run of two or more parts of the name, where a part is one of its words, a
 * word cut short by the bank ("ALBUQUERQ"), or an initial, and where "DE", "DA" and the like may
 * sit between parts. So "MARINA PRADO", "MARINA A. PRADO", "M A PRADO" and "MARINA DE PRADO" all
 * go.
 *
 * A single word of the name on its own is left alone, because it is as likely to be part of a
 * shop's name ("EMPORIO PRADO"). For the same reason a holder known by one word is not redacted
 * at all.
 */
export function redactName(text: string, normalizedName: string, placeholder: string): string {
  const words = [...new Set(normalizedName.split(/[\s-]+/).filter((token) => token.length >= 2 && !PARTICLES.has(token)))];
  if (words.length < 2) return text;
  const word = `(?:${words.map((w) => (w.length > 5 ? String.raw`${escapeRegExp(w.slice(0, 5))}\p{L}*` : escapeRegExp(w))).join("|")})`;
  const initial = String.raw`(?:[${[...new Set(words.map((w) => w[0]))].map((c) => escapeRegExp(c ?? "")).join("")}]\.?)`;
  const gap = String.raw`(?:[\s-]+(?:DE|DA|DO|DAS|DOS|E))?[\s-]+`;
  const pattern = String.raw`(?<![\p{L}\p{N}])(?:(?:${initial}${gap})*${word}(?:${gap}(?:${word}|${initial}))+|(?:${initial}${gap})+${word})(?![\p{L}\p{N}])`;
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(new RegExp(pattern, "giu"), placeholder);
}

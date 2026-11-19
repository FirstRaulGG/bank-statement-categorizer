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

// One alternation, tried left to right at each position, so the more specific shape wins.
const IDENTIFIERS = new RegExp(
  [
    String.raw`(?<email>[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)`,
    // A random Pix key is a UUID.
    String.raw`(?<key>\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)`,
    String.raw`(?<cnpj>(?<!\d)\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}(?!\d))`,
    // Also the half-masked form banks print, such as ***.456.789-**.
    String.raw`(?<cpf>(?<![\d*])[\d*]{3}\.[\d*]{3}\.[\d*]{3}-[\d*]{2}(?![\d*]))`,
    String.raw`(?<phone>(?<!\d)(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]\d{4}(?!\d))`,
    String.raw`(?<run>(?<!\d)\d{7,}(?!\d))`,
  ].join("|"),
  "giu",
);

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
 * check digits are right: a wrong guess costs a placeholder, a missed one leaks a person.
 */
export function scrub(text: string, options: ScrubOptions = {}): string {
  return text.replace(IDENTIFIERS, (match, ...rest) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    if (groups.email) return "[email]";
    if (groups.key) return "[key]";
    if (groups.cnpj) return options.maskCompanyIds ? "[cnpj]" : match;
    if (groups.cpf) return "[cpf]";
    if (groups.phone) return "[phone]";
    if (match.length === 11) return "[cpf]";
    // A bare 14-digit run is kept only if it really is a company id; otherwise it is some code.
    if (match.length === 14 && isValidCnpj(match)) return options.maskCompanyIds ? "[cnpj]" : match;
    return "[number]";
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces a person's name inside already-normalised text (upper case, no accents). Any run of two
 * or more consecutive words that all belong to the name is replaced, so "MARINA PRADO" and
 * "MARINA A PRADO" both go, while a lone "PRADO" in a shop's name stays.
 */
export function redactName(text: string, normalizedName: string, placeholder: string): string {
  const words = [...new Set(normalizedName.split(" ").filter((token) => token.length >= 2))];
  if (words.length < 2) return text;
  // A middle name is often printed as its initial.
  const initials = [...new Set(words.map((word) => word[0] ?? ""))].filter(Boolean);
  const word = `(?:${words.map(escapeRegExp).join("|")})`;
  const wordOrInitial = `(?:${[...words, ...initials].map(escapeRegExp).join("|")})`;
  return text.replace(new RegExp(String.raw`(?<![\p{L}\p{N}])${word}(?:\s+${wordOrInitial})+(?![\p{L}\p{N}])`, "giu"), placeholder);
}

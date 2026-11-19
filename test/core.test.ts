import { describe, expect, it } from "vitest";

import { anchorOf, cleanDescription, describeLine, detectRail } from "../src/core/clean.js";
import { looksLikePerson, similarNames, DEFAULT_TRADE_WORDS } from "../src/core/person.js";
import { isValidCnpj, isValidCpf, redactName, scrub } from "../src/core/pii.js";
import { defineTaxonomy, signAllows } from "../src/core/taxonomy.js";
import { formatCents } from "../src/core/types.js";
import { EMPLOYER_CNPJ, FRIEND_CPF, HOLDER_CPF } from "../src/example/statement.js";
import { exampleGolden } from "../src/example/golden.js";
import { someValidCpf } from "./helpers.js";

const TRADE = new Set(DEFAULT_TRADE_WORDS);

describe("scrub", () => {
  it("masks a CPF in every form a bank prints it", () => {
    expect(scrub("PIX 123.456.789-00 FULANO")).toBe("PIX [cpf] FULANO");
    expect(scrub("PIX 12345678900 FULANO")).toBe("PIX [cpf] FULANO");
    expect(scrub("PIX ***.456.789-** FULANO")).toBe("PIX [cpf] FULANO");
  });

  it("masks by shape, whether or not the check digits are right", () => {
    expect(isValidCpf("123.456.789-00")).toBe(false);
    expect(scrub("123.456.789-00")).toBe("[cpf]");
    expect(scrub(someValidCpf())).toBe("[cpf]");
  });

  it("keeps a punctuated company id unless asked to hide it", () => {
    expect(scrub("LOJA 12.345.678/0001-00")).toBe("LOJA 12.345.678/0001-00");
    expect(scrub("LOJA 12.345.678/0001-00", { maskCompanyIds: true })).toBe("LOJA [cnpj]");
  });

  it("treats a bare 14-digit run as a code unless it really is a company id", () => {
    expect(isValidCnpj("00123456789012")).toBe(false);
    expect(scrub("BOLETO 00123456789012")).toBe("BOLETO [number]");
  });

  it("masks Pix keys: e-mail, phone and random key", () => {
    expect(scrub("PIX contato@loja.example.test LOJA")).toBe("PIX [email] LOJA");
    expect(scrub("PIX (11) 98765-4321 OFICINA")).toBe("PIX [phone] OFICINA");
    expect(scrub("PIX +55 11 98765-4321")).toBe("PIX [phone]");
    expect(scrub("PIX 3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d LOJA")).toBe("PIX [key] LOJA");
  });

  it("masks long digit runs and leaves short ones", () => {
    expect(scrub("DOC 1234567 REF 123456")).toBe("DOC [number] REF 123456");
    expect(scrub("PARCELA 02/12 VALOR 150")).toBe("PARCELA 02/12 VALOR 150");
  });

  it("removes the holder's name, initials included, but not a shop that shares one word", () => {
    const name = "MARINA ALBUQUERQUE PRADO";
    expect(redactName("PIX MARINA ALBUQUERQUE PRADO", name, "[H]")).toBe("PIX [H]");
    expect(redactName("PIX MARINA A PRADO", name, "[H]")).toBe("PIX [H]");
    expect(redactName("Paid to Marina Prado", name, "[H]")).toBe("Paid to [H]");
    expect(redactName("EMPORIO PRADO VERDE", name, "[H]")).toBe("EMPORIO PRADO VERDE");
  });
});

describe("check digits", () => {
  it("accepts exactly one pair of check digits per base", () => {
    const valid = Array.from({ length: 100 }, (_, n) => `100200300${String(n).padStart(2, "0")}`).filter(isValidCpf);
    expect(valid).toHaveLength(1);
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });

  it("the example data cannot belong to anyone", () => {
    expect(isValidCpf(HOLDER_CPF)).toBe(false);
    expect(isValidCpf(FRIEND_CPF)).toBe(false);
    expect(isValidCnpj(EMPLOYER_CNPJ)).toBe(false);
    for (const golden of exampleGolden) {
      for (const run of `${golden.description} ${golden.counterparty?.document ?? ""}`.match(/\d[\d./-]{9,}\d/g) ?? []) {
        expect(isValidCpf(run) || isValidCnpj(run)).toBe(false);
      }
    }
  });
});

describe("cleanDescription", () => {
  it.each([
    ["PIX ENVIADO - PADARIA TRIGO DOURADO", "PADARIA TRIGO DOURADO"],
    ["PAG*PADARIA TRIGO DOURADO CAMPINAS BR", "PADARIA TRIGO DOURADO"],
    ["Compra Cartão Débito Farmácia Vida Plena 11987654321", "FARMACIA VIDA PLENA"],
    ["SUPERMERCADO BOA SAFRA 03/03", "SUPERMERCADO BOA SAFRA"],
    ["CINE LUMEN ASSINATURA PARC 02/12", "CINE LUMEN ASSINATURA"],
    ["PAGTO BOLETO COMPANHIA LUZ DO VALE ENERGIA 00123456789012", "COMPANHIA LUZ DO VALE ENERGIA"],
    ["DEB AUTOMATICO FIBRA RAPIDA INTERNET", "FIBRA RAPIDA INTERNET"],
    ["TED RECEBIDA ATELIE NORTE SUL LTDA", "ATELIE NORTE SUL LTDA"],
  ])("%s", (raw, cleaned) => {
    expect(cleanDescription(raw)).toBe(cleaned);
  });

  it("does not cut a shop named after a place when no country marker follows", () => {
    expect(cleanDescription("COMPRA CARTAO EMPORIO CAMPINAS")).toBe("EMPORIO CAMPINAS");
  });

  it("never strips a line down to nothing", () => {
    expect(cleanDescription("PIX")).toBe("PIX");
    expect(cleanDescription("PIX ENVIADO")).not.toBe("");
  });

  it("falls back to the bank's structured name when the line is only a label", () => {
    expect(describeLine("PIX ENVIADO", { name: "Loja Violeta Ltda" })).toBe("LOJA VIOLETA LTDA");
    expect(describeLine("PIX ENVIADO LOJA AURORA", { name: "Outra Coisa" })).toBe("LOJA AURORA");
  });

  it("reads the rail", () => {
    expect(detectRail("PIX ENVIADO X")).toBe("pix");
    expect(detectRail("TRANSFERENCIA ENTRE CONTAS")).toBe("transfer");
    expect(detectRail("PAGTO BOLETO X")).toBe("boleto");
    expect(detectRail("PADARIA X")).toBeNull();
  });
});

describe("anchorOf", () => {
  it("uses the company id when there is one", () => {
    expect(anchorOf("LOJA X", "LOJA X 12.345.678/0001-00", undefined)).toBe("cnpj:12345678000100");
    expect(anchorOf("LOJA X", "LOJA X", { document: "12.345.678/0001-00" })).toBe("cnpj:12345678000100");
  });

  it("never contains a CPF, a phone number or an e-mail", () => {
    const anchor = anchorOf("JOAQUIM TAVARES LIMA", "PIX ENVIADO JOAQUIM TAVARES LIMA", { document: OTHER });
    expect(anchor).toMatch(/^person:[0-9a-f]{16}$/);
    expect(anchor).not.toContain("987654321");
    expect(anchorOf("(11) 98765-4321 OFICINA DOIS IRMAOS", "PIX (11) 98765-4321 OFICINA DOIS IRMAOS", undefined)).toBe("OFICINA DOIS");
    expect(anchorOf("CONTATO@LOJA.EXAMPLE.TEST LOJA VIOLETA", "PIX CONTATO@LOJA.EXAMPLE.TEST LOJA VIOLETA", undefined)).toBe("LOJA VIOLETA");
  });

  it("keys the person hash when a secret is given", () => {
    const plain = anchorOf("X", "X", { document: OTHER });
    const keyed = anchorOf("X", "X", { document: OTHER }, { anchorSecret: "s3cret" });
    expect(keyed).not.toBe(plain);
    expect(anchorOf("X", "X", { document: OTHER }, { anchorSecret: "s3cret" })).toBe(keyed);
  });

  it("skips connecting words and does not take a boleto code for a company", () => {
    expect(anchorOf("COMPANHIA LUZ DO VALE ENERGIA", "PAGTO BOLETO COMPANHIA LUZ DO VALE ENERGIA 00123456789012", undefined)).toBe("COMPANHIA LUZ");
  });
});

const OTHER = "987.654.321-11";

describe("looksLikePerson", () => {
  const check = (text: string, rail: "pix" | "card" | null, document?: string) =>
    looksLikePerson({ text, rail, anchor: "A", ...(document ? { counterparty: { document } } : {}) }, TRADE);

  it("is exact with a document", () => {
    expect(check("PADARIA TRIGO DOURADO", "pix", OTHER)).toBe(true);
    expect(check("JOAQUIM TAVARES LIMA", "pix", "12.345.678/0001-00")).toBe(false);
  });

  it("guesses 'person' for plain names on a person-to-person rail", () => {
    expect(check("HELENA DUARTE", "pix")).toBe(true);
    expect(check("MARIA DA SILVA SOUZA", "pix")).toBe(true);
  });

  it("does not for shops, companies, card purchases or text with codes", () => {
    expect(check("PADARIA TRIGO DOURADO", "pix")).toBe(false);
    expect(check("ATELIE NORTE SUL LTDA", "pix")).toBe(false);
    expect(check("HELENA DUARTE", "card")).toBe(false);
    expect(check("[phone] OFICINA DOIS IRMAOS", "pix")).toBe(false);
    expect(check("HELENA", "pix")).toBe(false);
  });
});

describe("similarNames", () => {
  it.each([
    ["MARINA A PRADO", "Marina Albuquerque Prado", true],
    ["MARINA PRADO", "Marina Albuquerque Prado", true],
    ["PIX RECEBIDO MARINA ALBUQUERQUE PRADO", "Marina Albuquerque Prado", true],
    ["MARINA", "Marina Albuquerque Prado", true],
    ["CARLOS PRADO", "Marina Albuquerque Prado", false],
    ["MARINA SOUZA LIMA", "Marina Albuquerque Prado", false],
    ["", "Marina Albuquerque Prado", false],
  ])("%s ~ %s -> %s", (a, b, expected) => {
    expect(similarNames(a, b)).toBe(expected);
  });
});

describe("taxonomy", () => {
  it("binds role to direction", () => {
    expect(signAllows("income", "out")).toBe(false);
    expect(signAllows("expense", "in")).toBe(false);
    expect(signAllows("transfer", "in")).toBe(true);
    expect(signAllows("neutral", "out")).toBe(true);
  });

  it("refuses a misconfigured category list at start-up", () => {
    const categories = [
      { id: "a", name: "A", role: "expense" as const },
      { id: "t", name: "T", role: "transfer" as const },
      { id: "s", name: "S", role: "income" as const },
    ];
    expect(() => defineTaxonomy({ categories, special: { ownTransfer: "a", cardBill: "t" } })).toThrow(/role transfer/);
    expect(() => defineTaxonomy({ categories, special: { ownTransfer: "t", cardBill: "missing" } })).toThrow(/does not exist/);
    expect(() => defineTaxonomy({ categories, special: { ownTransfer: "t", cardBill: "t", salary: "s" } })).toThrow(/otherIncome/);
    expect(() => defineTaxonomy({ categories: [...categories, { id: "a2", name: "á", role: "expense" }], special: { ownTransfer: "t", cardBill: "t" } })).toThrow(/named/);
  });

  it("formats cents without floating point", () => {
    expect(formatCents(123456)).toBe("1234.56");
    expect(formatCents(-5)).toBe("-0.05");
    expect(formatCents(1999999999)).toBe("19999999.99");
  });
});

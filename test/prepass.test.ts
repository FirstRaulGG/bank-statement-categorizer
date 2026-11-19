import { describe, expect, it } from "vitest";

import { exampleTaxonomy as taxonomy } from "../src/example/taxonomy.js";
import { compileDictionary } from "../src/prepass/dictionary.js";
import { buildHistory } from "../src/prepass/history.js";
import { cardCredits, holderTransfers, oppositeTwins } from "../src/prepass/transfers.js";
import type { PastDecision } from "../src/core/types.js";
import { HOLDER, HOLDER_DOC, OTHER_DOC, prepared, tx } from "./helpers.js";

describe("holder transfers", () => {
  it("needs the holder's document AND a transfer rail", () => {
    const a = tx("PIX ENVIADO MARINA A PRADO", -1000, { counterparty: { document: HOLDER_DOC } });
    const noRail = tx("MARINA A PRADO", -1000, { counterparty: { document: HOLDER_DOC } });
    const other = tx("PIX ENVIADO JOAQUIM TAVARES", -1000, { counterparty: { document: OTHER_DOC } });
    const found = holderTransfers(prepared([a, noRail, other]), HOLDER, taxonomy);
    expect([...found.keys()]).toEqual([a.id]);
    expect(found.get(a.id)?.categoryId).toBe("own_transfer");
  });

  it("does not neutralise salary, yields or fees stamped with the holder's document", () => {
    const lines = ["TED RECEBIDA SALARIO EMPRESA X", "PIX RECEBIDO RENDIMENTOS CONTA", "TED TARIFA SERVICO"].map((line) =>
      tx(line, 1000, { counterparty: { document: HOLDER_DOC } }),
    );
    expect(holderTransfers(prepared(lines), HOLDER, taxonomy).size).toBe(0);
  });

  it("ignores a company id, even the holder's own company", () => {
    const line = tx("PIX ENVIADO MINHA EMPRESA LTDA", -1000, { counterparty: { document: "12.345.678/0001-00" } });
    expect(holderTransfers(prepared([line]), { ...HOLDER, documents: [HOLDER_DOC, "12.345.678/0001-00"] }, taxonomy).size).toBe(0);
  });
});

describe("opposite twins", () => {
  const twins = (transactions: ReturnType<typeof tx>[]) => oppositeTwins(prepared(transactions), new Map(), HOLDER, taxonomy);

  it("pairs a movement between the holder's accounts when a leg names the holder", () => {
    const out = tx("PIX ENVIADO MARINA A PRADO", -120_000);
    const into = tx("PIX RECEBIDO MARINA ALBUQUERQUE PRADO", 120_000, { accountId: "chk2" });
    const { resolutions } = twins([out, into]);
    expect(resolutions.get(out.id)?.categoryId).toBe("own_transfer");
    expect(resolutions.get(into.id)?.categoryId).toBe("own_transfer");
  });

  it("does not pair two strangers who happen to move the same amount on the same day", () => {
    const out = tx("PIX ENVIADO JOAQUIM TAVARES LIMA", -5000);
    const into = tx("PIX RECEBIDO HELENA DUARTE", 5000, { accountId: "chk2" });
    expect(twins([out, into]).resolutions.size).toBe(0);
  });

  it("does not pair when one leg names the holder and the other names somebody else", () => {
    const out = tx("PIX ENVIADO JOAQUIM TAVARES LIMA", -5000);
    const into = tx("PIX RECEBIDO MARINA ALBUQUERQUE PRADO", 5000, { accountId: "chk2" });
    expect(twins([out, into]).resolutions.size).toBe(0);
  });

  it("lets a leg already settled as an own transfer anchor its mirror, without rewriting it", () => {
    const out = tx("PIX ENVIADO", -5000);
    const into = tx("PIX RECEBIDO", 5000, { accountId: "chk2" });
    const settled = new Map([[out.id, { categoryId: "own_transfer", confidence: "high" as const, stage: "holder_transfer" as const, reason: "" }]]);
    const { resolutions } = oppositeTwins(prepared([out, into]), settled, HOLDER, taxonomy);
    expect([...resolutions.keys()]).toEqual([into.id]);
  });

  it("needs different days to stay apart, different accounts to pair", () => {
    const out = tx("PIX ENVIADO MARINA PRADO", -5000);
    expect(twins([out, tx("PIX RECEBIDO MARINA PRADO", 5000, { accountId: "chk2", date: "2026-03-11" })]).resolutions.size).toBe(0);
    expect(twins([out, tx("PIX RECEBIDO MARINA PRADO", 5000)]).resolutions.size).toBe(0);
  });

  it("recognises the card bill from either line", () => {
    const pay = tx("PAGTO FATURA CARTAO", -234_567);
    const credit = tx("CREDITO", 234_567, { accountId: "card" });
    expect(twins([pay, credit]).resolutions.get(pay.id)?.categoryId).toBe("card_bill");

    const vague = tx("DEBITO DIVERSOS", -9000);
    const received = tx("PAGAMENTO RECEBIDO", 9000, { accountId: "card" });
    expect(twins([vague, received]).resolutions.get(vague.id)?.categoryId).toBe("card_bill");
  });

  it("does not take a card purchase and a deposit for a bill payment", () => {
    const purchase = tx("LOJA AURORA", -9000, { accountId: "card" });
    const deposit = tx("PIX RECEBIDO HELENA DUARTE", 9000);
    expect(twins([purchase, deposit]).resolutions.size).toBe(0);
    const outNoMarker = tx("LOJA AURORA", -7000);
    const cardIn = tx("AJUSTE", 7000, { accountId: "card" });
    expect(twins([outNoMarker, cardIn]).resolutions.size).toBe(0);
  });

  it("leaves a day with two candidates alone and says so", () => {
    const a = tx("PIX ENVIADO MARINA PRADO", -5000);
    const b = tx("PIX ENVIADO MARINA PRADO", -5000);
    const into = tx("PIX RECEBIDO MARINA PRADO", 5000, { accountId: "chk2" });
    const result = twins([a, b, into]);
    expect(result.resolutions.size).toBe(0);
    expect(result.ambiguous).toBe(1);
  });

  it("gives the same answer when run again", () => {
    const out = tx("PIX ENVIADO MARINA A PRADO", -120_000);
    const into = tx("PIX RECEBIDO MARINA ALBUQUERQUE PRADO", 120_000, { accountId: "chk2" });
    expect(Object.fromEntries(twins([out, into]).resolutions)).toEqual(Object.fromEntries(twins([into, out]).resolutions));
  });
});

describe("card credits", () => {
  it("settles every unsettled credit on a card account, and nothing else", () => {
    const credit = tx("ESTORNO LIVRARIA", 8990, { accountId: "card" });
    const purchase = tx("LIVRARIA", -8990, { accountId: "card", date: "2026-03-01" });
    const deposit = tx("ESTORNO LOJA", 100);
    const found = cardCredits(prepared([credit, purchase, deposit]), new Map(), taxonomy);
    expect([...found.keys()]).toEqual([credit.id]);
  });
});

describe("history", () => {
  const today = "2026-03-31";
  const row = (extra: Partial<PastDecision>): PastDecision => ({ anchor: "PIZZARIA FORNO", direction: "out", categoryId: "eating_out", source: "manual", decidedAt: "2026-03-01", ...extra });
  const lookup = (rows: PastDecision[], anchor = "PIZZARIA FORNO") => buildHistory(rows, taxonomy, { today }).lookup(anchor, "out");

  it("inherits from one manual choice, at high confidence", () => {
    expect(lookup([row({})])).toMatchObject({ categoryId: "eating_out", confidence: "high", stage: "history" });
  });

  it("needs model answers from two different days, and then only reaches medium", () => {
    const model = row({ source: "model", confidence: "high" });
    expect(lookup([model])).toBeNull();
    // Ten rows of the same day are one answer about ten transactions.
    expect(lookup(Array.from({ length: 10 }, () => model))).toBeNull();
    expect(lookup([model, row({ source: "model", confidence: "medium", decidedAt: "2026-03-08" })])).toMatchObject({ confidence: "medium" });
  });

  it("counts a row whose date cannot be read for nothing", () => {
    const bad = (decidedAt: string) => row({ source: "model", confidence: "high", decidedAt });
    expect(lookup([bad("soon"), bad("2026-13-45")])).toBeNull();
    expect(lookup([bad("not a date"), row({ source: "model", confidence: "high" })])).toBeNull();
  });

  it("ignores model answers that are fresh or were low confidence", () => {
    expect(lookup([row({ source: "model", confidence: "high", decidedAt: "2026-03-28" }), row({ source: "model", confidence: "high", decidedAt: "2026-03-29" })])).toBeNull();
    expect(lookup([row({ source: "model", confidence: "low" }), row({ source: "model", confidence: "low" })])).toBeNull();
  });

  it("requires unanimity", () => {
    expect(lookup([row({}), row({ categoryId: "groceries" })])).toBeNull();
  });

  it("keeps directions apart", () => {
    expect(buildHistory([row({})], taxonomy, { today }).lookup("PIZZARIA FORNO", "in")).toBeNull();
  });

  it("is vetoed by a transfer on file for the same key", () => {
    expect(lookup([row({}), row({ categoryId: "own_transfer" })])).toBeNull();
  });

  it("never counts the generic buckets, unknown categories or sign-incoherent rows", () => {
    expect(lookup([row({ categoryId: "pix_sent" })])).toBeNull();
    expect(lookup([row({ categoryId: "gone" })])).toBeNull();
    expect(lookup([row({ categoryId: "salary" })])).toBeNull();
  });

  it("accepts only manual evidence about an individual", () => {
    const person = "person:0123456789abcdef";
    const model = row({ anchor: person, source: "model", confidence: "high" });
    expect(lookup([model, model], person)).toBeNull();
    expect(lookup([row({ anchor: person, categoryId: "housing" })], person)).toMatchObject({ categoryId: "housing" });
  });
});

describe("dictionary", () => {
  const dictionary = compileDictionary(
    [
      { id: "bar", pattern: "BAR", categoryId: "eating_out" },
      { id: "station", pattern: "POSTO", categoryId: "transport" },
      { id: "pharmacy", pattern: "FARMACIA", categoryId: "health", trusted: true },
      { id: "salary", pattern: "SALARIO", categoryId: "salary" },
      { id: "re", pattern: "^UNIV\\w+", match: "regex", categoryId: "education" },
    ],
    taxonomy,
  );

  it("requires short patterns to stand as a word", () => {
    expect(dictionary.match("BARBEARIA DO ZE", "out")).toBeNull();
    expect(dictionary.match("BAR DO ZE", "out")?.rule.id).toBe("bar");
  });

  it("prefers the leftmost match", () => {
    expect(dictionary.match("POSTO ESTRELA FARMACIA", "out")?.rule.id).toBe("station");
    expect(dictionary.match("FARMACIA DO POSTO", "out")?.rule.id).toBe("pharmacy");
  });

  it("skips a rule whose category disagrees with the direction", () => {
    expect(dictionary.match("ADIANTAMENTO SALARIO DEVOLVIDO", "out")).toBeNull();
    expect(dictionary.match("SALARIO", "in")?.rule.id).toBe("salary");
  });

  it("grades a regular expression lower than plain text", () => {
    expect(dictionary.match("UNIVERSIDADE LIVRE", "out")).toMatchObject({ confidence: "medium" });
    expect(dictionary.match("FARMACIA X", "out")).toMatchObject({ confidence: "high" });
  });

  it("refuses broken rules at start-up", () => {
    expect(() => compileDictionary([{ id: "x", pattern: "ABC", categoryId: "nope" }], taxonomy)).toThrow(/does not exist/);
    expect(() => compileDictionary([{ id: "x", pattern: "(", match: "regex", categoryId: "health" }], taxonomy)).toThrow();
    expect(() => compileDictionary([{ id: "x", pattern: "AB", categoryId: "health" }, { id: "x", pattern: "CD", categoryId: "health" }], taxonomy)).toThrow(/duplicate/);
  });
});

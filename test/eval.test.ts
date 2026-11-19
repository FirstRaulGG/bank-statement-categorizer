import { describe, expect, it } from "vitest";

import type { PromptGroup } from "../src/agent/prompt.js";
import { formatComparison, formatEval } from "../src/eval/report.js";
import { compareEvals, majority, runEval } from "../src/eval/run.js";
import type { GoldenCase } from "../src/eval/run.js";
import { exampleGolden } from "../src/example/golden.js";
import { offlineAnswer, offlineModel } from "../src/example/offline-model.js";
import { exampleDictionary, exampleTaxonomy as taxonomy } from "../src/example/taxonomy.js";
import { ScriptedLlm } from "../src/llm/scripted.js";

const CASES: GoldenCase[] = [
  { id: "a", description: "LOJA AURORA", amountCents: -100, account: "card", expected: "shopping" },
  { id: "b", description: "LOJA BRISA", amountCents: -100, account: "card", expected: "shopping" },
  { id: "c", description: "PADARIA X", amountCents: -100, account: "card", expected: "eating_out" },
];
const all = (categoryId: string) => (groups: PromptGroup[]) => ({ decisions: groups.map((g) => ({ key: g.key, categoryId, confidence: "high", reason: "r" })) });

describe("majority", () => {
  it("picks the most frequent answer and reports how often it was given", () => {
    expect(majority(["x", "x", "y"])).toEqual({ winner: "x", share: 2 / 3 });
    expect(majority([null, null, "y"])).toEqual({ winner: null, share: 2 / 3 });
  });

  it("breaks a tie by first seen, so the result is repeatable", () => {
    expect(majority(["y", "x"]).winner).toBe("y");
    expect(majority(["x", "y"]).winner).toBe("x");
  });
});

describe("runEval", () => {
  it("grades against the expected category", async () => {
    const report = await runEval(CASES, { taxonomy, llm: new ScriptedLlm(all("shopping")) });
    expect(report).toMatchObject({ total: 3, correct: 2, unresolved: 0, samples: 1, consistency: null });
    expect(report.accuracy).toBeCloseTo(2 / 3);
    expect(report.confusions).toEqual([{ expected: "eating_out", got: "shopping", count: 1 }]);
    expect(report.byCategory).toEqual({ shopping: { total: 2, correct: 2 }, eating_out: { total: 1, correct: 0 } });
  });

  it("counts an answer the guards blocked as unresolved, not as correct", async () => {
    const report = await runEval(CASES, { taxonomy, llm: new ScriptedLlm(all("salary")) });
    expect(report).toMatchObject({ correct: 0, unresolved: 3 });
    expect(report.cases[0]).toMatchObject({ got: null, guard: "sign_mismatch" });
  });

  it("counts a low-confidence answer: the eval measures answers, then reports them by confidence", async () => {
    const llm = new ScriptedLlm((groups) => ({ decisions: groups.map((g) => ({ key: g.key, categoryId: "shopping", confidence: "low" })) }));
    const report = await runEval(CASES, { taxonomy, llm });
    expect(report.correct).toBe(2);
    expect(report.byConfidence).toEqual({ low: { total: 3, correct: 2 } });
  });

  it("takes the majority over several samples and measures agreement", async () => {
    let sample = 0;
    const llm = new ScriptedLlm((groups) => {
      sample += 1;
      return all(sample === 2 ? "leisure" : "shopping")(groups);
    });
    const report = await runEval(CASES, { taxonomy, llm, samples: 3 });
    expect(report.cases[0]).toMatchObject({ got: "shopping", votes: ["shopping", "leisure", "shopping"] });
    expect(report.cases[0]?.consistency).toBeCloseTo(2 / 3);
    expect(report.consistency).toBeCloseTo(2 / 3);
    expect(report.correct).toBe(2);
  });

  it("separates what the rules settled from what the model decided", async () => {
    const cases: GoldenCase[] = [...CASES, { id: "d", description: "FARMACIA VIDA PLENA", amountCents: -100, account: "card", expected: "health" }];
    const report = await runEval(cases, { taxonomy, dictionary: exampleDictionary, llm: new ScriptedLlm(all("shopping")) });
    expect(report.byStage).toEqual({ model: { total: 3, correct: 2 }, dictionary: { total: 1, correct: 1 } });
    expect(report.modelOnly).toEqual({ total: 3, correct: 2 });
  });

  it("keeps two cases with the same amount from being paired as a transfer", async () => {
    const cases: GoldenCase[] = [
      { id: "out", description: "PIX ENVIADO EVAL HOLDER", amountCents: -500, account: "checking", expected: "pix_sent" },
      { id: "in", description: "PAGAMENTO RECEBIDO", amountCents: 500, account: "card", expected: "card_bill" },
    ];
    const report = await runEval(cases, { taxonomy, llm: new ScriptedLlm(all("shopping")) });
    expect(report.cases.map((c) => c.stage)).toEqual(["person_bucket", "card_credit"]);
  });

  it("repeats a case over several months when asked, which is what makes a salary a salary", async () => {
    const salary = (months: number): GoldenCase[] => [{ id: "s", description: "TED RECEBIDA EMPRESA X LTDA", amountCents: 100, account: "checking", months, expected: "salary" }];
    expect((await runEval(salary(1), { taxonomy, llm: new ScriptedLlm(all("salary")) })).cases[0]?.got).toBe("other_income");
    expect((await runEval(salary(3), { taxonomy, llm: new ScriptedLlm(all("salary")) })).cases[0]?.got).toBe("salary");
  });

  it("adds a judge's score without letting it change a verdict", async () => {
    const judge = new ScriptedLlm((_groups, _messages, call) => (call === 2 ? "no idea" : { score: 4, critique: "Cites the shop." }));
    const report = await runEval(CASES, { taxonomy, llm: new ScriptedLlm(all("shopping")), judge });
    expect(judge.calls).toHaveLength(3);
    expect(report.judge).toMatchObject({ mean: 4, scored: 2, unreadable: 1 });
    expect(report.cases.map((c) => c.judge?.score)).toEqual([4, null, 4]);
    expect(report.correct).toBe(2);
    expect(judge.transcript()).toContain('"expected":"Shopping"');
  });

  it("refuses a golden set that expects a category that does not exist, or repeats an id", async () => {
    const llm = new ScriptedLlm(all("shopping"));
    await expect(runEval([{ ...CASES[0]!, expected: "nope" }], { taxonomy, llm })).rejects.toThrow(/does not exist/);
    await expect(runEval([CASES[0]!, CASES[0]!], { taxonomy, llm })).rejects.toThrow(/twice/);
  });
});

describe("comparing two runs", () => {
  it("lists what B fixed and what it broke", async () => {
    const a = await runEval(CASES, { taxonomy, llm: new ScriptedLlm(all("shopping"), { model: "A" }) });
    const b = await runEval(CASES, { taxonomy, llm: new ScriptedLlm(all("eating_out"), { model: "B" }) });
    const comparison = compareEvals(a, b);
    expect(comparison).toMatchObject({ fixed: ["c"], broken: ["a", "b"] });
    expect(comparison.accuracyDelta).toBeCloseTo(-1 / 3);
    expect(formatComparison(a, b, comparison)).toContain("Broken by B (2): a, b");
    expect(() => compareEvals(a, { ...b, cases: b.cases.slice(1) })).toThrow(/same golden set/);
  });
});

describe("the example golden set, offline", () => {
  it("runs end to end and fails exactly where the stand-in is wrong", async () => {
    const report = await runEval(exampleGolden, { taxonomy, dictionary: exampleDictionary, llm: offlineModel() });
    const wrong = report.cases.filter((c) => !c.correct).map((c) => c.id);
    expect(wrong).toEqual(["health-post", "bookshop", "injection"]);
    expect(report.total).toBe(exampleGolden.length);
    const text = formatEval(report, taxonomy);
    expect(text).toContain(`Accuracy: ${exampleGolden.length - 3}/${exampleGolden.length}`);
    expect(text).toContain("n/a (no price for this model)");
  });

  it("the stand-in abstains when no keyword fits", () => {
    expect(offlineAnswer({ key: "g1", text: "LIVRARIA PAGINA VIRADA", direction: "out", account: "card", rail: null, count: 1, months: 1, total: "1.00" })).toEqual({ key: "g1", categoryId: null });
  });
});

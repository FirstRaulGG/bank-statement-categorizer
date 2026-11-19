// Measuring the agent against answers a person wrote down.
//
// A prompt change that "feels better" on three examples is how accuracy quietly drops. The eval
// runs a golden set through the real pipeline (same passes, same parser, same guards) and reports
// a number, so that a prompt or a model is swapped with evidence and not with a hunch.

import type { PriceTable } from "../agent/cost.js";
import { visibleText } from "../agent/prompt.js";
import { categorize } from "../agent/run.js";
import { describeLine } from "../core/clean.js";
import type { Taxonomy } from "../core/taxonomy.js";
import type { AccountKind, Confidence, Counterparty, Holder, Stage, Transaction } from "../core/types.js";
import { ZERO_USAGE, addUsage, extractJson } from "../llm/types.js";
import type { LlmClient, LlmUsage } from "../llm/types.js";
import type { DictionaryRule } from "../prepass/dictionary.js";

/** One labelled example: a group of transactions with the same counterparty, and the right category. */
export interface GoldenCase {
  id: string;
  /** The line as a bank would print it. Synthetic or anonymised: a golden set is a file people share. */
  description: string;
  /** Negative for money out. */
  amountCents: number;
  account: AccountKind;
  /** In how many consecutive months the line appears. Default 1. */
  months?: number;
  counterparty?: Counterparty;
  /** Category id a person chose. */
  expected: string;
  notes?: string;
}

export interface EvalOptions {
  taxonomy: Taxonomy;
  llm: LlmClient;
  dictionary?: readonly DictionaryRule[];
  prices?: PriceTable;
  /**
   * How many times to run the whole set. With more than one, each case's answer is the majority
   * vote and the report includes how often the samples agreed. Default 1.
   */
  samples?: number;
  /** A second model that scores each reason from 1 to 5. It never changes whether a case counts as correct. */
  judge?: LlmClient;
  context?: string;
  batchSize?: number;
  holder?: Holder;
}

export interface CaseResult {
  id: string;
  expected: string;
  /** The winning answer, or `null` when the pipeline wrote nothing. */
  got: string | null;
  correct: boolean;
  votes: (string | null)[];
  /** Share of samples that gave the winning answer. `null` with a single sample. */
  consistency: number | null;
  stage: Stage;
  confidence: Confidence | null;
  reason: string;
  guard?: string;
  judge?: { score: number | null; critique: string };
}

export interface Tally {
  total: number;
  correct: number;
}

export interface EvalReport {
  model: string;
  samples: number;
  total: number;
  correct: number;
  accuracy: number;
  /** Cases where nothing was written (the model abstained, a guard blocked it, or it was unreachable). */
  unresolved: number;
  /** Accuracy over the cases the model itself decided, leaving out what the rules settled. */
  modelOnly: Tally;
  byCategory: Record<string, Tally>;
  byStage: Record<string, Tally>;
  byConfidence: Record<string, Tally>;
  /** Wrong answers, most frequent first. */
  confusions: { expected: string; got: string | null; count: number }[];
  /** Mean consistency across cases, or `null` with a single sample. */
  consistency: number | null;
  usage: LlmUsage;
  costUsd: number | null;
  llmUnavailable: boolean;
  judge?: { mean: number | null; scored: number; unreadable: number; usage: LlmUsage };
  cases: CaseResult[];
}

const EVAL_HOLDER: Holder = { name: "Eval Holder", documents: [] };

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Turns the cases into transactions. Every case gets its own stretch of the calendar, so that two
 * cases with the same amount can never be mistaken for the two legs of a transfer.
 */
function transactionsFor(cases: readonly GoldenCase[]): Transaction[] {
  const transactions: Transaction[] = [];
  cases.forEach((golden, index) => {
    const months = Math.min(12, Math.max(1, golden.months ?? 1));
    for (let k = 0; k < months; k += 1) {
      transactions.push({
        id: `${golden.id}#${k}`,
        accountId: golden.account,
        date: addDays("2001-01-15", index * 400 + k * 30),
        amountCents: golden.amountCents,
        description: golden.description,
        ...(golden.counterparty ? { counterparty: golden.counterparty } : {}),
      });
    }
  });
  return transactions;
}

/** The most frequent value. On a tie the one seen first wins, so the result does not depend on chance. */
export function majority<T>(votes: readonly T[]): { winner: T; share: number } {
  const counts = new Map<T, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  let winner = votes[0] as T;
  let best = 0;
  for (const [value, count] of counts) {
    if (count > best) {
      winner = value;
      best = count;
    }
  }
  return { winner, share: best / votes.length };
}

function tally(target: Record<string, Tally>, key: string, correct: boolean): void {
  const entry = (target[key] ??= { total: 0, correct: 0 });
  entry.total += 1;
  if (correct) entry.correct += 1;
}

const JUDGE_SYSTEM = [
  "You review the reasoning of a system that categorizes bank transactions.",
  "You are given the transaction, the category a person chose, the category the system chose, and the system's reason.",
  "Score the REASON from 1 to 5: 5 means it cites what is actually in the text and would convince a careful accountant; 1 means it is unrelated, invented or merely restates the answer.",
  "Judge the reason, not the outcome: a wrong answer can have a sensible reason and a right one can be a lucky guess.",
  'Reply with JSON only: {"score": 1-5, "critique": "one sentence"}',
].join("\n");

export async function runEval(cases: readonly GoldenCase[], options: EvalOptions): Promise<EvalReport> {
  const { taxonomy } = options;
  const ids = new Set<string>();
  for (const golden of cases) {
    if (ids.has(golden.id)) throw new Error(`golden case id "${golden.id}" appears twice`);
    ids.add(golden.id);
    if (!taxonomy.get(golden.expected)) throw new Error(`golden case "${golden.id}" expects a category that does not exist: "${golden.expected}"`);
  }

  const samples = Math.max(1, Math.trunc(options.samples ?? 1));
  const holder = options.holder ?? EVAL_HOLDER;
  const transactions = transactionsFor(cases);
  const accounts = [
    { id: "checking", kind: "checking" as const },
    { id: "card", kind: "card" as const },
  ];

  let usage = ZERO_USAGE;
  let costUsd: number | null = 0;
  let llmUnavailable = false;
  let model = "";
  const perSample: Map<string, { got: string | null; stage: Stage; confidence: Confidence | null; reason: string; guard?: string }>[] = [];

  for (let sample = 0; sample < samples; sample += 1) {
    const report = await categorize(
      { transactions, accounts, holder },
      {
        taxonomy,
        llm: options.llm,
        dictionary: options.dictionary,
        prices: options.prices,
        context: options.context,
        batchSize: options.batchSize,
        // Every answer counts, whatever its confidence: the eval measures the answer, and reports
        // accuracy by confidence so that the threshold can be chosen from data.
        applyAt: "low",
        maxMs: 10 * 60_000,
        callTimeoutMs: 120_000,
      },
    );
    usage = addUsage(usage, report.usage);
    costUsd = costUsd === null || report.costUsd === null ? null : costUsd + report.costUsd;
    llmUnavailable ||= report.llmUnavailable;
    model = report.model ?? model;
    const first = new Map(report.decisions.filter((decision) => decision.transactionId.endsWith("#0")).map((decision) => [decision.transactionId.slice(0, -2), decision]));
    perSample.push(
      new Map(
        cases.map((golden) => {
          const decision = first.get(golden.id)!;
          return [
            golden.id,
            {
              got: decision.status === "applied" ? decision.categoryId : null,
              stage: decision.stage,
              confidence: decision.confidence,
              reason: decision.reason,
              ...(decision.guard ? { guard: decision.guard } : {}),
            },
          ];
        }),
      ),
    );
  }

  const results: CaseResult[] = cases.map((golden) => {
    const answers = perSample.map((sample) => sample.get(golden.id)!);
    const votes = answers.map((answer) => answer.got);
    const { winner, share } = majority(votes);
    const source = answers.find((answer) => answer.got === winner)!;
    return {
      id: golden.id,
      expected: golden.expected,
      got: winner,
      correct: winner === golden.expected,
      votes,
      consistency: samples > 1 ? share : null,
      stage: source.stage,
      confidence: source.confidence,
      reason: source.reason,
      ...(source.guard ? { guard: source.guard } : {}),
    };
  });

  let judge: EvalReport["judge"];
  if (options.judge) {
    let judgeUsage = ZERO_USAGE;
    let sum = 0;
    let scored = 0;
    let unreadable = 0;
    const byId = new Map(cases.map((golden) => [golden.id, golden]));
    for (const result of results) {
      // Only the model's own answers have a reason worth judging; rule-based ones are fixed text.
      if (result.stage !== "model") continue;
      const golden = byId.get(result.id)!;
      const reply = await options.judge.complete([
        { role: "system", content: JUDGE_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            text: visibleText(describeLine(golden.description, golden.counterparty), holder.name),
            direction: golden.amountCents < 0 ? "out" : "in",
            expected: taxonomy.get(result.expected)?.name,
            chosen: result.got ? taxonomy.get(result.got)?.name : null,
            reason: result.reason,
          }),
        },
      ]);
      judgeUsage = addUsage(judgeUsage, reply.usage);
      const parsed = extractJson(reply.text) as { score?: unknown; critique?: unknown } | null;
      const score = typeof parsed?.score === "number" && parsed.score >= 1 && parsed.score <= 5 ? parsed.score : null;
      if (score === null) unreadable += 1;
      else {
        sum += score;
        scored += 1;
      }
      result.judge = { score, critique: typeof parsed?.critique === "string" ? parsed.critique.slice(0, 300) : "" };
    }
    judge = { mean: scored ? sum / scored : null, scored, unreadable, usage: judgeUsage };
  }

  const byCategory: Record<string, Tally> = {};
  const byStage: Record<string, Tally> = {};
  const byConfidence: Record<string, Tally> = {};
  const confusion = new Map<string, { expected: string; got: string | null; count: number }>();
  const modelOnly: Tally = { total: 0, correct: 0 };
  for (const result of results) {
    tally(byCategory, result.expected, result.correct);
    tally(byStage, result.stage, result.correct);
    tally(byConfidence, result.confidence ?? "none", result.correct);
    if (result.stage === "model") {
      modelOnly.total += 1;
      if (result.correct) modelOnly.correct += 1;
    }
    if (!result.correct) {
      const key = `${result.expected}>${result.got ?? ""}`;
      const entry = confusion.get(key) ?? { expected: result.expected, got: result.got, count: 0 };
      entry.count += 1;
      confusion.set(key, entry);
    }
  }
  const correct = results.filter((result) => result.correct).length;


  return {
    model,
    samples,
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    unresolved: results.filter((result) => result.got === null).length,
    modelOnly,
    byCategory,
    byStage,
    byConfidence,
    confusions: [...confusion.values()].sort((a, b) => b.count - a.count),
    consistency: samples > 1 ? results.reduce((sum, result) => sum + (result.consistency ?? 0), 0) / Math.max(1, results.length) : null,
    usage,
    costUsd,
    llmUnavailable,
    ...(judge ? { judge } : {}),
    cases: results,
  };
}

export interface Comparison {
  accuracyDelta: number;
  /** Wrong under A, right under B. */
  fixed: string[];
  /** Right under A, wrong under B. */
  broken: string[];
  costDelta: number | null;
}

/** B compared with A, over the same golden set. */
export function compareEvals(a: EvalReport, b: EvalReport): Comparison {
  const before = new Map(a.cases.map((result) => [result.id, result.correct]));
  const fixed: string[] = [];
  const broken: string[] = [];
  for (const result of b.cases) {
    const was = before.get(result.id);
    if (was === undefined) throw new Error("the two reports are not over the same golden set");
    if (!was && result.correct) fixed.push(result.id);
    if (was && !result.correct) broken.push(result.id);
  }
  if (a.cases.length !== b.cases.length) throw new Error("the two reports are not over the same golden set");
  return {
    accuracyDelta: b.accuracy - a.accuracy,
    fixed,
    broken,
    costDelta: a.costUsd === null || b.costUsd === null ? null : b.costUsd - a.costUsd,
  };
}

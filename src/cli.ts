#!/usr/bin/env node
// bank-statement-categorizer demo                 run the example statement through the pipeline, offline
// bank-statement-categorizer eval [options]       run a golden set and print the report

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { loadPriceTable } from "./agent/cost.js";
import type { PriceTable } from "./agent/cost.js";
import { categorize } from "./agent/run.js";
import { formatCents } from "./core/types.js";
import { digitsOf } from "./core/pii.js";
import { normalizeName } from "./core/taxonomy.js";
import { formatComparison, formatEval } from "./eval/report.js";
import { compareEvals, runEval } from "./eval/run.js";
import type { GoldenCase } from "./eval/run.js";
import { exampleGolden } from "./example/golden.js";
import { offlineModel } from "./example/offline-model.js";
import { FRIEND_CPF, HOLDER_CPF, THIRD_PARTY_NAMES, exampleAccounts, exampleHistory, exampleHolder, exampleTransactions } from "./example/statement.js";
import { exampleDictionary, exampleTaxonomy } from "./example/taxonomy.js";
import { ClaudeClient } from "./llm/claude.js";
import { OpenAiCompatibleClient } from "./llm/openai-compatible.js";
import type { LlmClient } from "./llm/types.js";

const out = (line = "") => process.stdout.write(`${line}\n`);

async function demo(): Promise<number> {
  const llm = offlineModel();
  const report = await categorize(
    { transactions: exampleTransactions, accounts: exampleAccounts, holder: exampleHolder, history: exampleHistory },
    { taxonomy: exampleTaxonomy, dictionary: exampleDictionary, llm },
  );

  out("A made-up statement, categorized with a keyword stand-in for the model (no key, no network).");
  out("The stand-in is wrong on purpose in places, to show what the code does with a wrong answer.");
  out();
  const byId = new Map(exampleTransactions.map((tx) => [tx.id, tx]));
  for (const decision of report.decisions) {
    const tx = byId.get(decision.transactionId)!;
    const category = decision.categoryId ? (exampleTaxonomy.get(decision.categoryId)?.name ?? decision.categoryId) : "-";
    const shown = decision.status === "applied" ? category : decision.status === "needs_review" ? `REVIEW${decision.categoryId ? ` (suggests ${category})` : ""}` : "PENDING";
    out(`${tx.id}  ${formatCents(tx.amountCents).padStart(9)}  ${decision.stage.padEnd(15)}  ${shown}${decision.guard ? `   [guard: ${decision.guard}]` : ""}`);
    out(`     ${tx.description}`);
  }

  out();
  out("Who decided:");
  for (const [stage, count] of Object.entries(report.byStage)) if (count) out(`  ${stage.padEnd(15)} ${count}`);
  out(`  model calls: ${report.llmCalls}; transactions that reached the model: ${report.byStage.model} of ${report.decisions.length}`);

  out();
  out("Everything the model was shown about the transactions:");
  const shownToModel = llm.calls.flatMap((call) => call.filter((message) => message.role === "user").map((message) => message.content));
  for (const message of shownToModel) out(message.split("\n").map((line) => `  ${line}`).join("\n"));

  // The demo doubles as a check, and CI runs it. It checks this statement: the names, documents
  // and contact details that are in the example. It proves nothing about other statements.
  const transcript = normalizeName(llm.transcript());
  const leaks = [
    ...[HOLDER_CPF, FRIEND_CPF].filter((cpf) => transcript.includes(cpf) || digitsOf(transcript).includes(digitsOf(cpf))).map((cpf) => `a CPF (${cpf.slice(0, 3)}...)`),
    ...[exampleHolder.name, ...THIRD_PARTY_NAMES].filter((name) => transcript.includes(normalizeName(name))).map(() => "a person's name"),
    ...(/@|98765-4321/.test(transcript) ? ["a contact detail"] : []),
  ];
  const expected: Record<string, [string, string | null]> = {
    t04: ["applied", "own_transfer"],
    t05: ["applied", "own_transfer"],
    t06: ["applied", "card_bill"],
    t08: ["applied", "card_bill"],
    t15: ["applied", "pix_sent"],
    t21: ["applied", "refund"],
    t22: ["applied", "other_income"],
    t23: ["needs_review", null],
  };
  const wrong = Object.entries(expected).filter(([id, [status, categoryId]]) => {
    const decision = report.decisions.find((entry) => entry.transactionId === id);
    return decision?.status !== status || decision.categoryId !== categoryId;
  });

  out();
  if (leaks.length || wrong.length) {
    for (const leak of leaks) out(`FAILED: the model was shown ${leak}.`);
    for (const [id] of wrong) out(`FAILED: ${id} was not decided as expected.`);
    return 1;
  }
  out("Checks passed: none of this statement's CPFs, personal names or contact details reached the model; transfers, the card bill,");
  out("the refund, the one-off payment and the injected instruction were each handled by code.");
  return 0;
}

function modelClient(provider: string, model: string | undefined): LlmClient {
  if (!model) throw new Error("name the model to evaluate with --model (or use --offline)");
  if (provider === "anthropic") return new ClaudeClient({ model });
  if (provider === "openai-compatible") {
    const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    if (!baseUrl || !apiKey) throw new Error("openai-compatible needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY");
    return new OpenAiCompatibleClient({ baseUrl, apiKey, model, timeoutMs: 120_000 });
  }
  throw new Error(`unknown provider "${provider}"`);
}

async function evaluate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      offline: { type: "boolean", default: false },
      golden: { type: "string" },
      samples: { type: "string", default: "1" },
      provider: { type: "string", default: "anthropic" },
      model: { type: "string" },
      compare: { type: "string" },
      "compare-provider": { type: "string" },
      "judge-model": { type: "string" },
      "judge-provider": { type: "string" },
      "apply-at": { type: "string", default: "low" },
      prices: { type: "string" },
      "no-dictionary": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  const cases: GoldenCase[] = values.golden ? (JSON.parse(readFileSync(values.golden, "utf8")) as { cases: GoldenCase[] }).cases : exampleGolden;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('a golden file is {"cases": [...]} with at least one case');
  const prices: PriceTable | undefined = values.prices ? loadPriceTable(JSON.parse(readFileSync(values.prices, "utf8"))) : undefined;
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 9) throw new Error("--samples is an integer from 1 to 9");

  const applyAt = values["apply-at"];
  if (applyAt !== "low" && applyAt !== "medium" && applyAt !== "high") throw new Error("--apply-at is low, medium or high");
  if (values.offline && (values.compare || values["judge-model"] || values.model)) {
    throw new Error("--offline measures no model: it cannot be combined with --model, --compare or --judge-model");
  }

  const shared = { taxonomy: exampleTaxonomy, dictionary: values["no-dictionary"] ? [] : exampleDictionary, prices, samples, applyAt } as const;
  const llm = values.offline ? offlineModel() : modelClient(values.provider, values.model);
  const judge = values["judge-model"] ? modelClient(values["judge-provider"] ?? values.provider, values["judge-model"]) : undefined;
  const report = await runEval(cases, { ...shared, llm, ...(judge ? { judge } : {}) });
  const other = values.compare ? await runEval(cases, { ...shared, llm: modelClient(values["compare-provider"] ?? values.provider, values.compare) }) : null;
  const comparison = other ? compareEvals(report, other) : null;

  if (values.json) {
    // One JSON document and nothing else, so the output can be piped.
    out(JSON.stringify({ offline: values.offline, report, ...(other ? { compared: other, comparison } : {}) }, null, 2));
  } else {
    if (values.offline) out("OFFLINE: answers come from a keyword stand-in. This exercises the harness; it measures no model.\n");
    if (judge && values["judge-model"] === values.model) out("WARNING: the judge is the model being evaluated. Its scores will flatter it.\n");
    out(formatEval(report, exampleTaxonomy));
    if (other && comparison) {
      out("\n--- comparison ---");
      out(`${formatEval(other, exampleTaxonomy)}\n`);
      out(formatComparison(report, other, comparison));
    }
  }
  // 2: some answers are missing because a provider was unreachable, so the figures are not comparable.
  return report.llmUnavailable || other?.llmUnavailable || report.judge?.failed ? 2 : 0;
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "demo" ? demo() : command === "eval" ? evaluate(rest) : null;
if (!run) {
  out("usage: bank-statement-categorizer demo | bank-statement-categorizer eval [--offline] [--golden file.json] [--samples n] [--provider anthropic|openai-compatible]");
  out("                                             [--model id] [--compare id] [--compare-provider p] [--judge-model id] [--judge-provider p]");
  out("                                             [--apply-at low|medium|high] [--prices prices.json] [--no-dictionary] [--json]");
  process.exitCode = command ? 1 : 0;
} else {
  run.then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

// Plain-text rendering of eval results, for a terminal or a pull request comment.

import type { Taxonomy } from "../core/taxonomy.js";
import type { Comparison, EvalReport, Tally } from "./run.js";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rate(entry: Tally): string {
  return `${entry.correct}/${entry.total}${entry.total ? ` (${percent(entry.correct / entry.total)})` : ""}`;
}

function cost(value: number | null): string {
  return value === null ? "n/a (no price for this model)" : `$${value.toFixed(4)}`;
}

function table(title: string, rows: Record<string, Tally>): string[] {
  const keys = Object.keys(rows).sort();
  const width = Math.max(...keys.map((key) => key.length), 4);
  return [title, ...keys.map((key) => `  ${key.padEnd(width)}  ${rate(rows[key]!)}`)];
}

export function formatEval(report: EvalReport, taxonomy: Taxonomy): string {
  const name = (id: string | null) => (id ? (taxonomy.get(id)?.name ?? id) : "(nothing written)");
  const lines = [
    `Model: ${report.model || "(none answered)"}    Samples: ${report.samples}`,
    `Accuracy: ${report.correct}/${report.total} (${percent(report.accuracy)})    Unresolved: ${report.unresolved}`,
    `Decided by the model itself: ${rate(report.modelOnly)}`,
    report.consistency === null ? "" : `Consistency across samples: ${percent(report.consistency)}`,
    `Tokens: ${report.usage.inputTokens} in (${report.usage.cachedInputTokens} cached), ${report.usage.outputTokens} out    Cost: ${cost(report.costUsd)}`,
    report.costUsd !== null && report.total
      ? `Cost per 1,000 golden cases at this rate: $${((report.costUsd / report.total / report.samples) * 1000).toFixed(2)} (a case is one counterparty, and cases settled by rules cost nothing)`
      : "",
    report.total < 200 ? `Note: with ${report.total} cases, a difference of a few points between two runs is noise.` : "",
    report.llmUnavailable ? "WARNING: the model was unavailable for part of this run. The figures above are not comparable." : "",
    report.judge
      ? `Judge (${report.judge.model || "no answer"}): mean reason score ${report.judge.mean === null ? "n/a" : report.judge.mean.toFixed(2)} over ${report.judge.scored} answers (${report.judge.unreadable} unreadable), cost ${cost(report.judge.costUsd)}${report.judge.failed ? " - STOPPED EARLY: the judge became unavailable" : ""}`
      : "",
    "",
    ...table("By stage (which part of the pipeline answered):", report.byStage),
    "",
    ...table("By confidence:", report.byConfidence),
    "",
    ...table("By expected category:", report.byCategory),
  ].filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""));

  if (report.confusions.length) {
    lines.push("", "Wrong answers:");
    for (const confusion of report.confusions) lines.push(`  ${confusion.count}x  expected ${name(confusion.expected)}, got ${name(confusion.got)}`);
    lines.push("", "Cases:");
    for (const result of report.cases.filter((entry) => !entry.correct)) {
      lines.push(`  ${result.id}: ${name(result.got)} via ${result.stage}${result.guard ? ` [${result.guard}]` : ""} - ${result.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatComparison(a: EvalReport, b: EvalReport, comparison: Comparison): string {
  const sign = (value: number) => (value > 0 ? "+" : value < 0 ? "-" : "");
  return [
    `A: ${a.model}  ${percent(a.accuracy)}  ${cost(a.costUsd)}`,
    `B: ${b.model}  ${percent(b.accuracy)}  ${cost(b.costUsd)}`,
    `B - A: ${sign(comparison.accuracyDelta)}${Math.abs(comparison.accuracyDelta * 100).toFixed(1)} points${
      comparison.costDelta === null ? "" : `, ${sign(comparison.costDelta)}$${Math.abs(comparison.costDelta).toFixed(4)}`
    }`,
    `Fixed by B (${comparison.fixed.length}): ${comparison.fixed.join(", ") || "-"}`,
    `Broken by B (${comparison.broken.length}): ${comparison.broken.join(", ") || "-"}`,
  ].join("\n");
}

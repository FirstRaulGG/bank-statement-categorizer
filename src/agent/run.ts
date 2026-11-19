// One run: from a list of transactions to a decision for each.
//
// The order is the design. Cheap, certain rules go first and take whatever they can prove; the
// model sees only what is left, with identifiers removed; and whatever the model answers passes
// through `decide` before it is written.
//
//   prepare -> holder transfers -> opposite twins -> card credits
//           -> per group: history -> trusted dictionary -> individuals
//           -> model (batched, time-boxed) -> parse -> decide -> apply or send to review

import { redactName, scrub } from "../core/pii.js";
import { DEFAULT_TRADE_WORDS } from "../core/person.js";
import { normalizeName, signAllows } from "../core/taxonomy.js";
import type { Taxonomy } from "../core/taxonomy.js";
import { CONFIDENCE_RANK } from "../core/types.js";
import type { Account, Confidence, Decision, Holder, PastDecision, Stage, Transaction } from "../core/types.js";
import { LlmOutputError, LlmUnavailableError, ZERO_USAGE, addUsage } from "../llm/types.js";
import type { LlmClient, LlmMessage, LlmUsage } from "../llm/types.js";
import { compileDictionary } from "../prepass/dictionary.js";
import type { DictionaryRule } from "../prepass/dictionary.js";
import { buildHistory } from "../prepass/history.js";
import { cardCredits, holderTransfers, oppositeTwins } from "../prepass/transfers.js";
import type { Resolution } from "../prepass/transfers.js";
import { estimateCost } from "./cost.js";
import type { PriceTable } from "./cost.js";
import { decide } from "./decide.js";
import { buildGroups } from "./group.js";
import type { Group } from "./group.js";
import { parseDecisions } from "./parse.js";
import type { Dropped } from "./parse.js";
import { prepare } from "./prepare.js";
import type { Prepared } from "./prepare.js";
import { HOLDER_PLACEHOLDER, buildMessages, promptGroup, systemPrompt } from "./prompt.js";
import type { PromptGroup } from "./prompt.js";

export interface CategorizeInput {
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  holder: Holder;
  /** Earlier classifications of this holder's transactions. See `prepass/history.ts`. */
  history?: readonly PastDecision[];
  /** `YYYY-MM-DD`. Defaults to the latest transaction date. */
  today?: string;
}

export interface CategorizeOptions {
  taxonomy: Taxonomy;
  dictionary?: readonly DictionaryRule[];
  /** Without a model the deterministic passes still run; everything else is left pending. */
  llm?: LlmClient;
  prices?: PriceTable;
  /**
   * Lowest confidence at which a model answer is written without a person. Default `medium`.
   * Below it the answer is kept as a suggestion and the transaction goes to review.
   */
  applyAt?: Confidence;
  /** Groups per model call. Default 20. Large batches are where replies come back empty or cut off. */
  batchSize?: number;
  /** Upper bound on the size of one batch's group lines, in characters. Default 6000. */
  maxBatchChars?: number;
  /** Groups sent to the model in one run, largest first. Default 300. */
  maxGroups?: number;
  /** Time budget for the whole run, in milliseconds. Default 45 000. Checked between batches. */
  maxMs?: number;
  /** Timeout of one model call. Default 25 000. */
  callTimeoutMs?: number;
  minHistoryAgeDays?: number;
  /** Hide company ids (CNPJ) from the model as well. */
  maskCompanyIds?: boolean;
  /** Words that mark a business rather than a person. Defaults to `DEFAULT_TRADE_WORDS`. */
  tradeWords?: readonly string[];
  anchorSecret?: string;
  /** A sentence about the holder for the prompt. It is sent to the model: no names, no documents. */
  context?: string;
  now?: () => number;
}

export interface RunReport {
  /** One per transaction, in input order. */
  decisions: Decision[];
  /** The anchor and direction of each transaction, for storing as history. */
  anchors: Record<string, string>;
  byStage: Record<Stage, number>;
  usage: LlmUsage;
  /** Estimated cost of the model calls, or `null` when a model without a price was used. */
  costUsd: number | null;
  llmCalls: number;
  /** The model that answered, as the provider named it. `null` when no call was answered. */
  model: string | null;
  /** The provider could not be reached. Undecided transactions are `pending`; run again later. */
  llmUnavailable: boolean;
  /** The time budget ran out before every batch was sent. */
  deadlineHit: boolean;
  /** Entries of the model's replies that were thrown away, and why. */
  dropped: Dropped[];
  /** For each untrusted dictionary rule that produced a hint: how often the final answer agreed. */
  ruleShadow: Record<string, { agree: number; disagree: number }>;
  /** Same-day, same-amount buckets with more than one candidate, left unpaired. */
  ambiguousTwins: number;
}

const NO_STAGES: Record<Stage, number> = {
  holder_transfer: 0,
  twin: 0,
  card_credit: 0,
  history: 0,
  dictionary: 0,
  person_bucket: 0,
  model: 0,
  none: 0,
};

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export async function categorize(input: CategorizeInput, options: CategorizeOptions): Promise<RunReport> {
  const { taxonomy } = options;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxMs ?? 45_000);
  const applyAt = options.applyAt ?? "medium";
  const batchSize = Math.max(1, options.batchSize ?? 20);
  const maxBatchChars = options.maxBatchChars ?? 6000;
  const callTimeoutMs = options.callTimeoutMs ?? 25_000;
  const holderName = normalizeName(input.holder.name);

  const items = prepare(input.transactions, input.accounts, {
    tradeWords: new Set((options.tradeWords ?? DEFAULT_TRADE_WORDS).map(normalizeName)),
    anchorSecret: options.anchorSecret,
  });
  const dictionary = compileDictionary(options.dictionary ?? [], taxonomy);
  const today = input.today ?? items.reduce((latest, item) => (item.tx.date > latest ? item.tx.date : latest), "0000-00-00");
  const history = buildHistory(input.history ?? [], taxonomy, { today, minAgeDays: options.minHistoryAgeDays });

  const decisions = new Map<string, Decision>();
  const settled = new Map<string, Resolution>();
  const report: Omit<RunReport, "decisions" | "anchors" | "byStage"> = {
    usage: ZERO_USAGE,
    costUsd: 0,
    llmCalls: 0,
    model: null,
    llmUnavailable: false,
    deadlineHit: false,
    dropped: [],
    ruleShadow: {},
    ambiguousTwins: 0,
  };

  /** The only place a rule-based category is written. The sign rule is checked here, for every pass. */
  const settle = (item: Prepared, resolution: Resolution): boolean => {
    const category = taxonomy.get(resolution.categoryId);
    if (!category || !signAllows(category.role, item.direction)) return false;
    settled.set(item.tx.id, resolution);
    decisions.set(item.tx.id, {
      transactionId: item.tx.id,
      status: "applied",
      categoryId: category.id,
      confidence: resolution.confidence,
      stage: resolution.stage,
      reason: resolution.reason,
      costUsd: 0,
    });
    return true;
  };
  const leave = (item: Prepared, status: "needs_review" | "pending", stage: Stage, reason: string, extra: Partial<Decision> = {}) => {
    decisions.set(item.tx.id, { transactionId: item.tx.id, status, categoryId: null, confidence: null, stage, reason, costUsd: 0, ...extra });
  };
  const byId = new Map(items.map((item) => [item.tx.id, item]));
  const settleAll = (found: ReadonlyMap<string, Resolution>) => {
    for (const [id, resolution] of found) settle(byId.get(id)!, resolution);
  };

  // --- Passes over single transactions ---------------------------------------------------------
  settleAll(holderTransfers(items, input.holder, taxonomy));
  const twins = oppositeTwins(items, settled, input.holder, taxonomy);
  report.ambiguousTwins = twins.ambiguous;
  settleAll(twins.resolutions);
  settleAll(cardCredits(items, settled, taxonomy));

  // --- Passes over groups ----------------------------------------------------------------------
  const forModel: Group[] = [];
  for (const group of buildGroups(items.filter((item) => !settled.has(item.tx.id)))) {
    const inherited = history.lookup(group.anchor, group.direction);
    if (inherited && group.items.every((item) => settle(item, inherited))) continue;

    const match = dictionary.match(group.text, group.direction);
    if (match?.rule.trusted) {
      const resolution: Resolution = {
        categoryId: match.rule.categoryId,
        confidence: match.confidence,
        stage: "dictionary",
        reason: `Matched the trusted dictionary rule "${match.rule.id}".`,
      };
      if (group.items.every((item) => settle(item, resolution))) continue;
    }

    if (group.person) {
      // An individual. What the money was for is not in the text, so the model is not asked.
      const bucket = group.direction === "out" ? taxonomy.special.personSent : taxonomy.special.personReceived;
      for (const item of group.items) {
        const done =
          bucket !== undefined &&
          settle(item, {
            categoryId: bucket,
            confidence: "low",
            stage: "person_bucket",
            reason: "A payment to or from an individual with no earlier classification. Not sent to the model.",
          });
        if (!done) leave(item, "needs_review", "person_bucket", "A payment to or from an individual. Not sent to the model.");
      }
      continue;
    }

    group.hint = match ?? null;
    forModel.push(group);
  }

  // --- The model -------------------------------------------------------------------------------
  const llm = options.llm;
  const queue = forModel.slice(0, options.maxGroups ?? 300);
  for (const group of forModel.slice(queue.length)) {
    for (const item of group.items) leave(item, "pending", "none", "Over the limit of groups for one run.");
  }

  if (!llm) {
    for (const group of queue) {
      for (const item of group.items) {
        if (group.hint) {
          leave(item, "needs_review", "dictionary", `Suggested by the untrusted dictionary rule "${group.hint.rule.id}". No model was configured to confirm it.`, {
            categoryId: group.hint.rule.categoryId,
            confidence: group.hint.confidence,
          });
        } else leave(item, "pending", "none", "No model configured.");
      }
    }
  } else {
    const promptOptions = { context: options.context, maskCompanyIds: options.maskCompanyIds };
    const system = systemPrompt(taxonomy, promptOptions);
    const lines = new Map<string, PromptGroup>(queue.map((group) => [group.key, promptGroup(group, input.holder.name, promptOptions)]));

    const batches: Group[][] = [];
    let current: Group[] = [];
    let chars = 0;
    for (const group of queue) {
      const size = JSON.stringify(lines.get(group.key)).length;
      if (current.length && (current.length >= batchSize || chars + size > maxBatchChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(group);
      chars += size;
    }
    if (current.length) batches.push(current);

    const cleanReason = (text: string): string => {
      const line = scrub(redactName(text, holderName, HOLDER_PLACEHOLDER), { maskCompanyIds: options.maskCompanyIds })
        .replace(/\s+/g, " ")
        .trim();
      return line.length > 300 ? `${line.slice(0, 299)}…` : line;
    };

    let stopReason: string | null = null;
    for (const batch of batches) {
      if (!stopReason && now() >= deadline) {
        report.deadlineHit = true;
        stopReason = "The run's time budget ran out before this group was sent.";
      }
      if (stopReason) {
        for (const group of batch) for (const item of group.items) leave(item, "pending", "none", stopReason);
        continue;
      }

      const keys = new Set(batch.map((group) => group.key));
      const messages: LlmMessage[] = buildMessages(system, batch.map((group) => lines.get(group.key)!));
      let batchUsage = ZERO_USAGE;
      let model = "";
      let proposals = new Map<string, { categoryId: string; confidence: Confidence; reason: string }>();

      // Two attempts. An unreadable reply is usually a one-off; a second one is not. A reply that
      // can be read and says "I do not know" is an answer, and is not asked again.
      let readable = false;
      let abstained = new Set<string | null>();
      for (let attempt = 0; attempt < 2 && !readable && !stopReason; attempt += 1) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        const request = attempt === 0 ? messages : [...messages, { role: "user" as const, content: "Your previous reply could not be read. Reply with the JSON object only." }];
        try {
          const result = await llm.complete(request, { signal: AbortSignal.timeout(Math.max(1, Math.min(callTimeoutMs, remaining))) });
          report.llmCalls += 1;
          batchUsage = addUsage(batchUsage, result.usage);
          model = result.model;
          report.model = result.model;
          const parsed = parseDecisions(result.text, keys, taxonomy);
          report.dropped.push(...parsed.dropped);
          proposals = new Map(parsed.proposals.map((proposal) => [proposal.key, proposal]));
          abstained = new Set(parsed.dropped.filter((entry) => entry.why === "the model abstained").map((entry) => entry.key));
          readable = parsed.proposals.length > 0 || parsed.dropped.some((entry) => entry.key !== null);
        } catch (err) {
          if (err instanceof LlmOutputError) {
            report.llmCalls += 1;
            continue;
          }
          if (err instanceof LlmUnavailableError || isAbort(err)) {
            report.llmUnavailable = true;
            stopReason = "The model was unavailable. Run again later.";
            break;
          }
          throw err;
        }
      }

      if (!stopReason && !readable && now() >= deadline) {
        report.deadlineHit = true;
        stopReason = "The run's time budget ran out before this group was answered.";
      }
      report.usage = addUsage(report.usage, batchUsage);
      const batchCost = model ? estimateCost(batchUsage, model, options.prices) : 0;
      report.costUsd = report.costUsd === null || batchCost === null ? null : report.costUsd + batchCost;
      if (stopReason) {
        for (const group of batch) for (const item of group.items) leave(item, "pending", "none", stopReason);
        continue;
      }

      // The batch's cost is shared by every group that was sent, answered or not: an unanswered
      // group was paid for all the same.
      const perGroup = batchCost === null ? null : batchCost / batch.length;
      for (const group of batch) {
        const costUsd = perGroup === null ? null : perGroup / group.items.length;
        const proposal = proposals.get(group.key);
        if (!proposal) {
          const why = abstained.has(group.key) ? "The model could not tell from the text." : "The model gave no usable answer for this group.";
          for (const item of group.items) leave(item, "needs_review", "model", why, { costUsd });
          continue;
        }
        const verdict = decide(group, proposal.categoryId, taxonomy);
        if (group.hint) {
          const shadow = (report.ruleShadow[group.hint.rule.id] ??= { agree: 0, disagree: 0 });
          if (verdict.categoryId === group.hint.rule.categoryId) shadow.agree += 1;
          else shadow.disagree += 1;
        }
        const reason = cleanReason(proposal.reason) || "No reason given.";
        for (const item of group.items) {
          if (verdict.categoryId === null) {
            leave(item, "needs_review", "model", reason, { guard: verdict.guard, costUsd });
            continue;
          }
          // An answer a guard had to change is not one to trust at full strength.
          const confidence: Confidence = verdict.guard && proposal.confidence === "high" ? "medium" : proposal.confidence;
          decisions.set(item.tx.id, {
            transactionId: item.tx.id,
            status: CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[applyAt] ? "applied" : "needs_review",
            categoryId: verdict.categoryId,
            confidence,
            stage: "model",
            reason,
            ...(verdict.guard ? { guard: verdict.guard } : {}),
            costUsd,
          });
        }
      }
    }
  }

  const ordered = items.map(
    (item): Decision =>
      decisions.get(item.tx.id) ?? { transactionId: item.tx.id, status: "pending", categoryId: null, confidence: null, stage: "none", reason: "Not reached.", costUsd: 0 },
  );
  const byStage = { ...NO_STAGES };
  for (const decision of ordered) byStage[decision.stage] += 1;
  return {
    ...report,
    decisions: ordered,
    anchors: Object.fromEntries(items.map((item) => [item.tx.id, item.anchor])),
    byStage,
  };
}

/**
 * What to store from a run so that it can serve as history later. Only answers of the model are
 * returned: an inherited or rule-based answer is not new evidence, and storing it as such is how
 * a system ends up agreeing with itself.
 */
export function toHistory(report: RunReport, transactions: readonly Transaction[], decidedAt: string): PastDecision[] {
  const byId = new Map(transactions.map((tx) => [tx.id, tx]));
  const rows: PastDecision[] = [];
  for (const decision of report.decisions) {
    const tx = byId.get(decision.transactionId);
    const anchor = report.anchors[decision.transactionId];
    if (!tx || !anchor || decision.stage !== "model" || decision.status !== "applied" || !decision.categoryId || !decision.confidence) continue;
    rows.push({ anchor, direction: tx.amountCents < 0 ? "out" : "in", categoryId: decision.categoryId, source: "model", confidence: decision.confidence, decidedAt });
  }
  return rows;
}

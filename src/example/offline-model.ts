// A stand-in for a model, so the demo and the eval run with no key and no network.
//
// It is a list of keywords, and it is wrong on purpose in three ways a real model can be wrong:
// it calls any line with the word SALARIO a salary (including one where a stranger typed the
// word), it calls a refund income, and it takes a one-off payment for a salary. The demo shows
// what the code does with those answers. Numbers produced with this stand-in say nothing about
// any real model.

import type { PromptGroup } from "../agent/prompt.js";
import { ScriptedLlm } from "../llm/scripted.js";

const KEYWORDS: readonly [RegExp, string, "high" | "medium" | "low", string][] = [
  [/SALARIO|AGENCIA/, "salary", "high", "The text mentions a salary or a regular service."],
  [/ESTORNO/, "other_income", "medium", "Money received."],
  [/SUPERMERCADO|MERCADO|HORTIFRUTI|ACOUGUE/, "groceries", "high", "A food retailer."],
  [/PADARIA|PIZZARIA|RESTAURANTE|LANCHONETE|CAFE/, "eating_out", "high", "A place that serves food."],
  [/POSTO|ESTACIONAMENTO/, "transport", "high", "A fuel station or parking."],
  [/OFICINA/, "transport", "low", "Possibly a car repair shop."],
  [/FARMACIA|DROGARIA|CLINICA|LABORATORIO/, "health", "high", "A pharmacy or health provider."],
  [/ENERGIA|AGUA|INTERNET|TELECOM/, "utilities", "high", "A utility bill."],
  [/ALUGUEL|CONDOMINIO/, "housing", "high", "A housing cost."],
  [/ESCOLA|COLEGIO|FACULDADE|CURSO/, "education", "high", "An education provider."],
  [/ASSINATURA/, "subscriptions", "medium", "The text says it is a subscription."],
  [/CINE|TEATRO|ACADEMIA/, "leisure", "medium", "A leisure venue."],
  [/LOJA|MAGAZINE/, "shopping", "medium", "A shop."],
  [/TARIFA|IOF|ANUIDADE/, "fees", "high", "A bank charge."],
];

const NAMES: Record<string, string> = {
  salary: "Salary",
  other_income: "Other income",
  groceries: "Groceries",
  eating_out: "Eating out",
  transport: "Transport",
  health: "Health",
  utilities: "Utilities",
  housing: "Housing",
  education: "Education",
  subscriptions: "Subscriptions",
  leisure: "Leisure",
  shopping: "Shopping",
  fees: "Bank fees and taxes",
};

export function offlineAnswer(group: PromptGroup): { key: string; categoryId: string | null; categoryName?: string; confidence?: string; reason?: string } {
  for (const [pattern, categoryId, confidence, reason] of KEYWORDS) {
    if (pattern.test(group.text)) return { key: group.key, categoryId, categoryName: NAMES[categoryId], confidence, reason };
  }
  if (group.hint && NAMES[group.hint]) {
    return { key: group.key, categoryId: group.hint, categoryName: NAMES[group.hint], confidence: "medium", reason: "Following the keyword hint." };
  }
  return { key: group.key, categoryId: null };
}

export function offlineModel(): ScriptedLlm {
  return new ScriptedLlm((groups) => ({ decisions: groups.map(offlineAnswer) }), { model: "offline-keywords" });
}

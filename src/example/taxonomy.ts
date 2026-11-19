// An example category list and dictionary for a personal budget. Everything here is made up for
// the demo and the tests: replace both with your own.

import { defineTaxonomy } from "../core/taxonomy.js";
import type { DictionaryRule } from "../prepass/dictionary.js";

export const exampleTaxonomy = defineTaxonomy({
  categories: [
    { id: "groceries", name: "Groceries", role: "expense", hint: "Supermarkets, greengrocers, butchers, bakeries when buying food to take home." },
    { id: "eating_out", name: "Eating out", role: "expense", hint: "Restaurants, snack bars, pizzerias, cafes, food delivery." },
    { id: "transport", name: "Transport", role: "expense", hint: "Fuel, parking, tolls, ride apps, public transport, car repairs." },
    { id: "health", name: "Health", role: "expense", hint: "Pharmacies, clinics, labs, health plans." },
    { id: "housing", name: "Housing", role: "expense", hint: "Rent, condominium fees, home repairs." },
    { id: "utilities", name: "Utilities", role: "expense", hint: "Electricity, water, gas, internet, phone." },
    { id: "education", name: "Education", role: "expense", hint: "School, university, courses, books for study." },
    { id: "leisure", name: "Leisure", role: "expense", hint: "Cinema, gym, travel, hobbies." },
    { id: "shopping", name: "Shopping", role: "expense", hint: "Clothing, electronics, household goods, gifts." },
    { id: "subscriptions", name: "Subscriptions", role: "expense", hint: "Recurring digital services." },
    { id: "fees", name: "Bank fees and taxes", role: "expense", hint: "Account fees, card annuity, IOF, interest charged." },
    { id: "pix_sent", name: "Sent to individuals", role: "expense", hint: "Not for you to choose: used by a rule when money goes to a person and nothing else is known." },
    { id: "salary", name: "Salary", role: "income", hint: "A recurring payment from an employer." },
    { id: "other_income", name: "Other income", role: "income", hint: "One-off payments for work, sales, prizes." },
    { id: "pix_received", name: "Received from individuals", role: "income", hint: "Not for you to choose: used by a rule when money comes from a person and nothing else is known." },
    { id: "own_transfer", name: "Transfer between own accounts", role: "transfer", hint: "Not for you to choose: decided by matching both sides of the movement." },
    { id: "card_bill", name: "Card bill payment", role: "neutral", hint: "Not for you to choose: decided by matching the payment with the card account." },
    { id: "refund", name: "Refund", role: "neutral", hint: "Money returned for something bought earlier." },
  ],
  special: {
    ownTransfer: "own_transfer",
    cardBill: "card_bill",
    refund: "refund",
    personSent: "pix_sent",
    personReceived: "pix_received",
    salary: "salary",
    otherIncome: "other_income",
  },
});

export const exampleDictionary: DictionaryRule[] = [
  { id: "supermarket", pattern: "SUPERMERCADO", categoryId: "groceries", trusted: true },
  { id: "pharmacy", pattern: "FARMACIA", categoryId: "health", trusted: true },
  { id: "drugstore", pattern: "DROGARIA", categoryId: "health", trusted: true },
  { id: "electricity", pattern: "ENERGIA", categoryId: "utilities", trusted: true },
  { id: "bank-fee", pattern: "TARIFA", categoryId: "fees", trusted: true },
  { id: "iof", pattern: "IOF", categoryId: "fees", trusted: true },
  // Not trusted: each of these words is usually one thing and sometimes another.
  { id: "station", pattern: "POSTO", categoryId: "transport" },
  { id: "bakery", pattern: "PADARIA", categoryId: "eating_out" },
  { id: "market", pattern: "MERCADO", categoryId: "groceries" },
  { id: "gym", pattern: "ACADEMIA", categoryId: "leisure" },
];

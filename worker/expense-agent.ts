import { Agent, run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { z } from "zod";

import type { ExpensePayload } from "./types";

const TRIAGE_MODEL = "gpt-5.4-nano";
const EXTRACTION_MODEL = "gpt-5.4-mini";

setTracingDisabled(true);

const ExpenseSchema = z
  .object({
    DateTime: z.string(),
    Place: z.string(),
    "Expense Type": z.string(),
    Amount: z.number(),
    item: z.string(),
  })
  .strict();

const expenseAgent = new Agent({
  name: "Expense Extractor",
  model: EXTRACTION_MODEL,
  instructions: [
    "Extract an expense record from the user's sentence.",
    "Return only the structured expense payload with exactly these keys:",
    "DateTime, Place, Expense Type, Amount, item.",
    "DateTime must be a string in 24-hour format YYYY-MM-DD HH.mm.ss.",
    "Place must be a string.",
    "Expense Type must be a string. Could be lunch, dinner or other category",
    "Amount must be a number without currency symbols.",
    "item must be a string describing what was bought.",
  ].join(" "),
  outputType: ExpenseSchema,
});


const expenseTriageAgent = Agent.create({
  name: "Expense Intake Triage Agent",
  model: TRIAGE_MODEL,
  instructions: [
    "Route messages that describe a purchase to the Expense Extractor agent.",
    "If a message does not contain enough purchase detail, ask for a clear expense sentence with date, place, amount, category, and item.",
    "Never invent fields; collect missing details before extraction.",
  ].join(" "),
  handoffs: [expenseAgent],
});

function stripCodeFences(value: string) {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
}

function normalizeExpensePayload(value: unknown): ExpensePayload {
  if (typeof value === "string") {
    return normalizeExpensePayload(JSON.parse(stripCodeFences(value)));
  }

  if (!value || typeof value !== "object") {
    throw new Error("The extracted expense payload is not a JSON object.");
  }

  const candidate = value as Record<string, unknown>;
  const amount =
    typeof candidate.Amount === "number"
      ? candidate.Amount
      : typeof candidate.Amount === "string"
        ? Number(candidate.Amount)
        : Number.NaN;

  if (
    typeof candidate.DateTime !== "string" ||
    typeof candidate.Place !== "string" ||
    typeof candidate["Expense Type"] !== "string" ||
    typeof candidate.item !== "string" ||
    !Number.isFinite(amount)
  ) {
    throw new Error("The extracted expense payload is missing required fields.");
  }

  return {
    DateTime: candidate.DateTime.trim(),
    Place: candidate.Place.trim(),
    "Expense Type": candidate["Expense Type"].trim(),
    Amount: amount,
    item: candidate.item.trim(),
  };
}

function isLikelyStructuredExpense(expense: ExpensePayload) {
  const dateTimePattern =
    /^\d{4}-\d{2}-\d{2}\s(?:[01]\d|2[0-3])\.\d{2}\.\d{2}$/;

  return (
    dateTimePattern.test(expense.DateTime) &&
    expense.Place.length > 0 &&
    expense["Expense Type"].length > 0 &&
    expense.item.length > 0 &&
    Number.isFinite(expense.Amount) &&
    expense.Amount > 0
  );
}

export function getRetryMessage() {
  return [
    "I couldn't map that message into the required expense JSON format.",
    "Please enter it again with enough detail, for example:",
    '{"DateTime":"2026-04-20 12.00.00","Place":"Four Seasion","Expense Type":"Lunch","Amount":10,"item":"Chicken Rice"}',
  ].join("\n\n");
}

export async function extractExpense(
  apiKey: string,
  sentence: string,
): Promise<{ expense: ExpensePayload }> {
  setDefaultOpenAIKey(apiKey);

  const now = new Date();
  const result = await run(
    expenseTriageAgent,
    [
      `Current date/time context: ${now.toISOString()}.`,
      "If the user uses a relative date such as today, yesterday, or tomorrow, resolve it from that context.",
      sentence,
    ].join("\n"),
  );
  const expense = normalizeExpensePayload(result.finalOutput);

  if (!isLikelyStructuredExpense(expense)) {
    throw new Error("The extracted expense payload is incomplete or invalid.");
  }

  return { expense };
}

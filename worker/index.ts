import { Agent, run, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ExpensePayload = {
  DateTime: string;
  Place: string;
  "Expense Type": string;
  Amount: number;
  item: string;
};

interface Env {
  DATABASE_URL?: string;
  OPENAI_API_KEY?: string;
}

export type WorkerDependencies = {
  extractExpense: typeof extractExpense;
  saveExpense: typeof saveExpense;
};

const DEFAULT_MODEL = "gpt-5.4-nano";

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
  model: DEFAULT_MODEL,
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

function getRuntimeEnv(name: "OPENAI_API_KEY" | "DATABASE_URL") {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  return runtime.process?.env?.[name];
}

function getOpenAIApiKey(env: Env) {
  return env.OPENAI_API_KEY ?? getRuntimeEnv("OPENAI_API_KEY");
}

function getDatabaseUrl(env: Env) {
  return env.DATABASE_URL ?? getRuntimeEnv("DATABASE_URL");
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

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

function getRetryMessage() {
  return [
    "I couldn't map that message into the required expense JSON format.",
    "Please enter it again with enough detail, for example:",
    '{"DateTime":"2026-04-20 12.00.00","Place":"Four Seasion","Expense Type":"Lunch","Amount":10,"item":"Chicken Rice"}',
  ].join("\n\n");
}

async function extractExpense(
  apiKey: string,
  sentence: string,
): Promise<{ expense: ExpensePayload }> {
  setDefaultOpenAIKey(apiKey);

  const now = new Date();
  const result = await run(
    expenseAgent,
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

async function saveExpense(
  databaseUrl: string,
  sourceText: string,
  expense: ExpensePayload,
) {
  const sql = neon(databaseUrl);

  await sql`
    CREATE TABLE IF NOT EXISTS expenses (
      id BIGSERIAL PRIMARY KEY,
      date_time TEXT NOT NULL,
      place TEXT NOT NULL,
      expense_type TEXT NOT NULL,
      amount NUMERIC(10, 2) NOT NULL,
      item TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      raw_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS item TEXT
  `;

  const inserted = (await sql`
    INSERT INTO expenses (
      date_time,
      place,
      expense_type,
      amount,
      item,
      raw_input,
      raw_json
    ) VALUES (
      ${expense.DateTime},
      ${expense.Place},
      ${expense["Expense Type"]},
      ${expense.Amount},
      ${expense.item},
      ${sourceText},
      ${JSON.stringify(expense)}::jsonb
    )
    RETURNING id, created_at
  `) as Array<{ id: number; created_at: string }>;

  return inserted[0];
}

export function createWorkerHandler(
  dependencies: WorkerDependencies = {
    extractExpense,
    saveExpense,
  },
) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/api/chat") {
        try {
          const body = (await request.json()) as { messages?: unknown };
          const messages = Array.isArray(body.messages)
            ? body.messages.filter(isChatMessage)
            : [];

          if (messages.length === 0) {
            return Response.json(
              { error: "Please send at least one chat message." },
              { status: 400 },
            );
          }

          const latestUserMessage =
            messages.findLast((message) => message.role === "user")?.content;

          if (!latestUserMessage) {
            return Response.json(
              { error: "No user message found to extract an expense from." },
              { status: 400 },
            );
          }

          const apiKey = getOpenAIApiKey(env);
          if (!apiKey) {
            return Response.json(
              {
                error:
                  "OPENAI_API_KEY is missing. Set it in the runtime environment or Wrangler config.",
              },
              { status: 500 },
            );
          }

          const databaseUrl = getDatabaseUrl(env);
          if (!databaseUrl) {
            return Response.json(
              {
                error:
                  "DATABASE_URL is missing. Set it in the runtime environment or Wrangler config.",
              },
              { status: 500 },
            );
          }

          let extracted;

          try {
            extracted = await dependencies.extractExpense(apiKey, latestUserMessage);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown extraction error.";

            if (
              errorMessage.includes("incomplete or invalid") ||
              errorMessage.includes("missing required fields") ||
              errorMessage.includes("not a JSON object")
            ) {
              return Response.json({
                reply: getRetryMessage(),
                needsRetry: true,
              });
            }

            console.error("Expense extraction failed", error);

            return Response.json(
              {
                error: `AI extraction failed: ${errorMessage}`,
              },
              { status: 500 },
            );
          }

          const { expense } = extracted;
          const inserted = await dependencies.saveExpense(
            databaseUrl,
            latestUserMessage,
            expense,
          );

          return Response.json({
            reply: JSON.stringify(
              {
                saved: true,
                expense,
                insertedId: inserted.id,
                createdAt: inserted.created_at,
              },
              null,
              2,
            ),
            expense,
            insertedId: inserted.id,
            createdAt: inserted.created_at,
          });
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Unexpected error while saving the expense.",
            },
            { status: 500 },
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      return new Response(null, { status: 404 });
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorkerHandler();

import { neon } from "@neondatabase/serverless";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ExpensePayload = {
  DateTime: string;
  Place: string;
  "Expense Type": string;
  Amount: number;
  item: string;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    reasoning_tokens?: number;
    reasoningTokens?: number;
  };
};

interface Env {
  DATABASE_URL?: string;
  OPENROUTER_API_KEY?: string;
}

const DEFAULT_MODEL = "openai/gpt-oss-120b:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function getRuntimeEnv(name: "OPENROUTER_API_KEY" | "DATABASE_URL") {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  return runtime.process?.env?.[name];
}

function getOpenRouterApiKey(env: Env) {
  return env.OPENROUTER_API_KEY ?? getRuntimeEnv("OPENROUTER_API_KEY");
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
    /^\d{4}-\d{2}-\d{2}\s\d{1,2}\.\d{2}\.\d{2}(am|pm)$/i;

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
    '{"DateTime":"2026-04-20 12.00.00pm","Place":"Four Seasion","Expense Type":"Lunch","Amount":10,"item":"Chicken Rice"}',
  ].join("\n\n");
}

async function extractExpense(
  apiKey: string,
  sentence: string,
): Promise<{ expense: ExpensePayload; reasoningTokens?: number }> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: [
            "Extract an expense record from the user's sentence.",
            "Return valid JSON only with exactly these keys:",
            'DateTime, Place, Expense Type, Amount, item',
            'DateTime must be a string in format YYYY-MM-DD hh.mm.ssam/pm.',
            "Place must be a string.",
            "Expense Type must be a string.",
            "Amount must be a number without currency symbols.",
            "item must be a string describing what was bought.",
            "Do not include markdown, explanation, or extra keys.",
          ].join(" "),
        },
        {
          role: "user",
          content: sentence,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "OpenRouter request failed.");
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter did not return structured expense content.");
  }

  const parsed = JSON.parse(stripCodeFences(content));
  const expense = normalizeExpensePayload(parsed);

  if (!isLikelyStructuredExpense(expense)) {
    throw new Error("The extracted expense payload is incomplete or invalid.");
  }

  const reasoningTokens =
    data.usage?.reasoningTokens ?? data.usage?.reasoning_tokens;

  return { expense, reasoningTokens };
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

export default {
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

        const apiKey = getOpenRouterApiKey(env);
        if (!apiKey) {
          return Response.json(
            {
              error:
                "OPENROUTER_API_KEY is missing. Set it in the runtime environment or Wrangler config.",
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
          extracted = await extractExpense(apiKey, latestUserMessage);
        } catch {
          return Response.json({
            reply: getRetryMessage(),
            needsRetry: true,
          });
        }

        const { expense, reasoningTokens } = extracted;
        const inserted = await saveExpense(databaseUrl, latestUserMessage, expense);

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
          reasoningTokens,
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

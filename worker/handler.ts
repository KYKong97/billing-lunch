import { saveExpense } from "./database";
import { extractExpense, getRetryMessage } from "./expense-agent";
import {
  getDatabaseUrl,
  getLatestUserMessage,
  getOpenAIApiKey,
  readChatMessages,
} from "./runtime";
import { answerSqlRequirement } from "./sql-agent";
import type { Env, SqlRequirementResult } from "./types";

export type WorkerDependencies = {
  extractExpense: typeof extractExpense;
  saveExpense: typeof saveExpense;
  answerSqlRequirement: typeof answerSqlRequirement;
};

type RequiredConfig =
  | { apiKey: string; databaseUrl: string }
  | { error: Response };

function getRequiredConfig(env: Env): RequiredConfig {
  const apiKey = getOpenAIApiKey(env);
  if (!apiKey) {
    return {
      error: Response.json(
        {
          error:
            "OPENAI_API_KEY is missing. Set it in the runtime environment or Wrangler config.",
        },
        { status: 500 },
      ),
    };
  }

  const databaseUrl = getDatabaseUrl(env);
  if (!databaseUrl) {
    return {
      error: Response.json(
        {
          error:
            "DATABASE_URL is missing. Set it in the runtime environment or Wrangler config.",
        },
        { status: 500 },
      ),
    };
  }

  return { apiKey, databaseUrl };
}

export function createWorkerHandler(
  dependencies: WorkerDependencies = {
    extractExpense,
    saveExpense,
    answerSqlRequirement,
  },
) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/api/chat") {
        try {
          const messages = await readChatMessages(request);

          if (messages.length === 0) {
            return Response.json(
              { error: "Please send at least one chat message." },
              { status: 400 },
            );
          }

          const latestUserMessage = getLatestUserMessage(messages);

          if (!latestUserMessage) {
            return Response.json(
              { error: "No user message found to extract an expense from." },
              { status: 400 },
            );
          }

          const config = getRequiredConfig(env);
          if ("error" in config) {
            return config.error;
          }

          let extracted;

          try {
            extracted = await dependencies.extractExpense(
              config.apiKey,
              latestUserMessage,
            );
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
            config.databaseUrl,
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

      if (request.method === "POST" && url.pathname === "/api/query") {
        try {
          const messages = await readChatMessages(request);

          if (messages.length === 0) {
            return Response.json(
              { error: "Please send a database requirement." },
              { status: 400 },
            );
          }

          const latestUserMessage = getLatestUserMessage(messages);

          if (!latestUserMessage) {
            return Response.json(
              { error: "No user requirement found to translate into SQL." },
              { status: 400 },
            );
          }

          const config = getRequiredConfig(env);
          if ("error" in config) {
            return config.error;
          }

          const queryResult: SqlRequirementResult =
            await dependencies.answerSqlRequirement(
              config.apiKey,
              config.databaseUrl,
              latestUserMessage,
            );

          return Response.json(queryResult);
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Unexpected error while querying expenses.",
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

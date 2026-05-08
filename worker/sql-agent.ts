import {
  Agent,
  run,
  setDefaultOpenAIKey,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import { z } from "zod";

import { executeExpenseSql } from "./database";
import type { SqlQueryResult, SqlRequirementResult } from "./types";

const TRIAGE_MODEL = "gpt-5.4-nano";
const SQL_MODEL = "gpt-5.4-mini";

setTracingDisabled(true);

const SCHEMA_DESCRIPTION = [
  "expenses schema:",
  "id bigint primary key",
  "date_time text not null, format YYYY-MM-DD HH.mm.ss",
  "place text not null",
  "expense_type text not null",
  "amount numeric not null",
  "raw_input text not null",
  "raw_json jsonb not null",
  "created_at timestamp with time zone not null default now()",
  "item text nullable",
].join("\n");

type SqlRunner = typeof executeExpenseSql;

function createSqlAgents(databaseUrl: string, sqlRunner: SqlRunner) {
  let latestQueryResult: SqlQueryResult | undefined;

  const runExpenseSqlTool = tool({
    name: "run_expense_sql",
    description:
      "Run one read-only SQL query against the expenses table and return the resulting rows.",
    parameters: z
      .object({
        sql: z
          .string()
          .describe("A single read-only SELECT or WITH query against expenses."),
      })
      .strict(),
    async execute({ sql }) {
      latestQueryResult = await sqlRunner(databaseUrl, sql);

      return JSON.stringify(latestQueryResult);
    },
  });

  const sqlAgent = new Agent({
    name: "Expense SQL Agent",
    handoffDescription:
      "Translates expense reporting requirements into read-only SQL and runs the query.",
    model: TRIAGE_MODEL,
    instructions: [
      "You translate the user's expense reporting requirement into PostgreSQL.",
      SCHEMA_DESCRIPTION,
      "Use only the run_expense_sql tool to query data.",
      "Generate exactly one SQL statement.",
      "Only use SELECT or WITH queries that read from expenses.",
      "Never modify data or schema.",
      "After the tool returns, answer concisely with the SQL used and the result.",
    ].join("\n\n"),
    tools: [runExpenseSqlTool],
  });

  const triageAgent = Agent.create({
    name: "Expense Requirement Triage Agent",
    model: SQL_MODEL,
    instructions: [
      "You triage user requirements for the expense database.",
      "For any request asking to inspect, summarize, total, filter, group, compare, or list expense data, hand off to the Expense SQL Agent.",
      "If the user asks to create, update, delete, drop, alter, or otherwise mutate data, refuse briefly and explain that only read-only expense analysis is supported.",
      "If the request is unrelated to expense data, ask for an expense reporting requirement.",
    ].join(" "),
    handoffs: [sqlAgent],
  });

  return {
    triageAgent,
    getLatestQueryResult: () => latestQueryResult,
  };
}

export async function answerSqlRequirement(
  apiKey: string,
  databaseUrl: string,
  requirement: string,
  sqlRunner: SqlRunner = executeExpenseSql,
): Promise<SqlRequirementResult> {
  setDefaultOpenAIKey(apiKey);

  const { triageAgent, getLatestQueryResult } = createSqlAgents(databaseUrl, sqlRunner);
  const result = await run(triageAgent, requirement);
  const queryResult = getLatestQueryResult();

  return {
    reply: String(result.finalOutput ?? ""),
    sql: queryResult?.sql,
    rows: queryResult?.rows,
    rowCount: queryResult?.rowCount,
  };
}

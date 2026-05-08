import { neon } from "@neondatabase/serverless";

import type { ExpensePayload, SqlQueryResult } from "./types";

const BLOCKED_SQL_KEYWORDS =
  /\b(alter|analyze|call|comment|copy|create|delete|drop|execute|grant|insert|merge|reindex|replace|revoke|truncate|update|vacuum)\b/i;

function normalizeSql(sql: string) {
  return sql.trim().replace(/;+\s*$/, "");
}

export function validateExpenseSql(sql: string) {
  const normalizedSql = normalizeSql(sql);

  if (!normalizedSql) {
    throw new Error("SQL is required.");
  }

  if (!/^(select|with)\b/i.test(normalizedSql)) {
    throw new Error("Only SELECT or WITH queries are allowed.");
  }

  if (normalizedSql.includes(";")) {
    throw new Error("Only one SQL statement is allowed.");
  }

  if (BLOCKED_SQL_KEYWORDS.test(normalizedSql)) {
    throw new Error("Only read-only expense queries are allowed.");
  }

  const referencedTables = [...normalizedSql.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map(
    (match) => match[1].toLowerCase(),
  );

  if (referencedTables.length === 0) {
    throw new Error("Query must read from the expenses table.");
  }

  const invalidTable = referencedTables.find(
    (table) => table !== "expenses" && table !== "public.expenses",
  );

  if (invalidTable) {
    throw new Error("Queries may only read from the expenses table.");
  }

  return normalizedSql;
}

export async function executeExpenseSql(
  databaseUrl: string,
  sqlText: string,
): Promise<SqlQueryResult> {
  const sql = neon(databaseUrl);
  const safeSql = validateExpenseSql(sqlText);
  const rows = (await sql.query(safeSql)) as Record<string, unknown>[];

  return {
    sql: safeSql,
    rows,
    rowCount: rows.length,
  };
}

export async function saveExpense(
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

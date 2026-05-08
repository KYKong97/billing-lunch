export type ChatRole = "user" | "assistant";

export type ChatMessage = {
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

export type Env = {
  DATABASE_URL?: string;
  OPENAI_API_KEY?: string;
};

export type SqlQueryResult = {
  sql: string;
  rows: Record<string, unknown>[];
  rowCount: number;
};

export type SqlRequirementResult = {
  reply: string;
  sql?: string;
  rows?: Record<string, unknown>[];
  rowCount?: number;
};

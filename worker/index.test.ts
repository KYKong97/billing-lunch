import { describe, expect, it, vi } from "vitest";

import {
  createWorkerHandler,
  type ExpensePayload,
  type WorkerDependencies,
} from "./index";

const env = {
  OPENAI_API_KEY: "test-openai-key",
  DATABASE_URL: "postgres://test-db",
};

const expense: ExpensePayload = {
  DateTime: "2026-05-08 12.30.00",
  Place: "GitHub Cafe",
  "Expense Type": "Lunch",
  Amount: 18.5,
  item: "Nasi lemak",
};

function makeRequest(body: unknown) {
  return new Request("https://billing-lunch.test/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDependencies(
  overrides: Partial<WorkerDependencies> = {},
): WorkerDependencies {
  return {
    extractExpense: vi.fn(async () => ({ expense })),
    saveExpense: vi.fn(async () => ({
      id: 42,
      created_at: "2026-05-08T04:30:00.000Z",
    })),
    ...overrides,
  };
}

describe("GitHub upload worker endpoint", () => {
  it("extracts the latest user message, saves the expense, and returns upload details", async () => {
    const dependencies = makeDependencies();
    const worker = createWorkerHandler(dependencies);

    const response = await worker.fetch(
      makeRequest({
        messages: [
          { role: "assistant", content: "What did you buy?" },
          { role: "user", content: "Lunch at GitHub Cafe was RM18.50" },
        ],
      }),
      env,
    );

    const body = (await response.json()) as {
      expense: ExpensePayload;
      insertedId: number;
      createdAt: string;
      reply: string;
    };

    expect(response.status).toBe(200);
    expect(dependencies.extractExpense).toHaveBeenCalledWith(
      env.OPENAI_API_KEY,
      "Lunch at GitHub Cafe was RM18.50",
    );
    expect(dependencies.saveExpense).toHaveBeenCalledWith(
      env.DATABASE_URL,
      "Lunch at GitHub Cafe was RM18.50",
      expense,
    );
    expect(body).toMatchObject({
      expense,
      insertedId: 42,
      createdAt: "2026-05-08T04:30:00.000Z",
    });
    expect(JSON.parse(body.reply)).toMatchObject({
      saved: true,
      insertedId: 42,
    });
  });

  it("rejects uploads without a valid chat message", async () => {
    const dependencies = makeDependencies();
    const worker = createWorkerHandler(dependencies);

    const response = await worker.fetch(
      makeRequest({ messages: [{ role: "user", content: "   " }] }),
      env,
    );

    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Please send at least one chat message.");
    expect(dependencies.extractExpense).not.toHaveBeenCalled();
    expect(dependencies.saveExpense).not.toHaveBeenCalled();
  });

  it("asks for a retry when extraction returns an incomplete payload", async () => {
    const dependencies = makeDependencies({
      extractExpense: vi.fn(async () => {
        throw new Error("The extracted expense payload is incomplete or invalid.");
      }),
    });
    const worker = createWorkerHandler(dependencies);

    const response = await worker.fetch(
      makeRequest({ messages: [{ role: "user", content: "Lunch RM10" }] }),
      env,
    );

    const body = (await response.json()) as {
      reply: string;
      needsRetry: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.needsRetry).toBe(true);
    expect(body.reply).toContain("required expense JSON format");
    expect(dependencies.saveExpense).not.toHaveBeenCalled();
  });

  it("returns a configuration error before upload when database credentials are missing", async () => {
    const dependencies = makeDependencies();
    const worker = createWorkerHandler(dependencies);

    const response = await worker.fetch(
      makeRequest({ messages: [{ role: "user", content: "Lunch RM10" }] }),
      { OPENAI_API_KEY: env.OPENAI_API_KEY },
    );

    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toContain("DATABASE_URL is missing");
    expect(dependencies.extractExpense).not.toHaveBeenCalled();
    expect(dependencies.saveExpense).not.toHaveBeenCalled();
  });
});

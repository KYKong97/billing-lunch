import type { ChatMessage, Env } from "./types";

export function getRuntimeEnv(name: "OPENAI_API_KEY" | "DATABASE_URL") {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  return runtime.process?.env?.[name];
}

export function getOpenAIApiKey(env: Env) {
  return env.OPENAI_API_KEY ?? getRuntimeEnv("OPENAI_API_KEY");
}

export function getDatabaseUrl(env: Env) {
  return env.DATABASE_URL ?? getRuntimeEnv("DATABASE_URL");
}

export function isChatMessage(value: unknown): value is ChatMessage {
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

export function getLatestUserMessage(messages: ChatMessage[]) {
  return messages.findLast((message) => message.role === "user")?.content;
}

export async function readChatMessages(request: Request) {
  const body = (await request.json()) as {
    messages?: unknown;
    requirement?: unknown;
  };

  if (typeof body.requirement === "string" && body.requirement.trim()) {
    return [{ role: "user", content: body.requirement.trim() }] satisfies ChatMessage[];
  }

  return Array.isArray(body.messages) ? body.messages.filter(isChatMessage) : [];
}

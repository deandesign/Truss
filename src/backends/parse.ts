import type { AgentEvent, Cost, Dialect } from "./types.js";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const rec = block as Record<string, unknown>;
      if (typeof rec.text === "string") return rec.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function ingestClaudeCursor(obj: Record<string, unknown>): AgentEvent | null {
  const type = String(obj.type ?? "");
  if (type === "result") return { kind: "result", raw: obj };
  if (type === "error") {
    return {
      kind: "error",
      text: String(obj.error ?? obj.result ?? obj.message ?? "error"),
    };
  }
  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const text =
      textFromContent(message?.content) ||
      (typeof obj.result === "string" ? obj.result : "") ||
      textFromContent(obj.content);
    if (!text) return null;
    return { kind: "assistant", text };
  }
  if (type === "tool_use" || obj.name) {
    const name = String(obj.name ?? obj.tool ?? "tool");
    return { kind: "tool", name, status: "started" };
  }
  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const tool = content.find(
        (b) =>
          b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "tool_result",
      );
      if (tool) {
        return {
          kind: "tool",
          name: String((tool as { name?: string }).name ?? "tool"),
          status: "completed",
        };
      }
    }
  }
  return null;
}

function ingestCodex(obj: Record<string, unknown>): AgentEvent | null {
  const type = String(obj.type ?? "");
  if (type === "error" || type === "turn.failed") {
    const error = obj.error as Record<string, unknown> | undefined;
    return {
      kind: "error",
      text: String(error?.message ?? obj.message ?? JSON.stringify(obj)),
    };
  }
  if (type === "item.started") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution" || item?.type === "file_change") {
      return {
        kind: "tool",
        name: String(item.command ?? item.type),
        status: "started",
      };
    }
  }
  if (type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      return { kind: "assistant", text: item.text };
    }
    if (item?.type === "command_execution" || item?.type === "file_change") {
      return {
        kind: "tool",
        name: String(item.command ?? item.type),
        status: "completed",
      };
    }
  }
  if (type === "turn.completed") {
    return { kind: "result", raw: obj };
  }
  if (type === "thread.started") {
    return { kind: "result", raw: obj };
  }
  return null;
}

export function ingestLine(line: string, dialect: Dialect): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (dialect === "codex") return ingestCodex(obj);
    return ingestClaudeCursor(obj);
  } catch {
    return null;
  }
}

export function ingestBuffer(buffer: string, dialect: Dialect): AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = buffer.split(/\r?\n/);
  const leftover: string[] = [];
  for (const line of lines) {
    const event = ingestLine(line, dialect);
    if (event) events.push(event);
    else leftover.push(line);
  }
  if (events.length === 0) {
    const joined = leftover.join("\n").trim();
    if (joined.startsWith("{")) {
      const event = ingestLine(joined, dialect);
      if (event) events.push(event);
    }
  }
  return events;
}

export function costFromRaw(raw: unknown): Cost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const usd =
    typeof rec.total_cost_usd === "number" ? rec.total_cost_usd : undefined;
  const usage = rec.usage as Record<string, unknown> | undefined;
  const tokens = usage
    ? {
        input:
          num(usage.input_tokens) ??
          num(usage.inputTokens) ??
          num(usage.input),
        output:
          num(usage.output_tokens) ??
          num(usage.outputTokens) ??
          num(usage.output),
        cacheRead:
          num(usage.cache_read_input_tokens) ?? num(usage.cached_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
      }
    : undefined;
  if (usd === undefined && !tokens) return undefined;
  return { usd, tokens };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function textFromRaw(raw: unknown, fallback = ""): string {
  if (!raw || typeof raw !== "object") return fallback;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.result === "string") return rec.result;
  if (typeof rec.text === "string") return rec.text;
  return fallback;
}

export function sessionFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.session_id === "string") return rec.session_id;
  if (typeof rec.thread_id === "string") return rec.thread_id;
  return undefined;
}

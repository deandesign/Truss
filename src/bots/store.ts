import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { botsDir } from "../core/paths.js";

export interface BotIdentity {
  id: string;
  name: string;
  title: string;
  role: string;
}

export function botPath(id: string): string {
  return join(botsDir(), id);
}

export function parseIdentity(id: string, markdown: string): BotIdentity {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = match ? match[2] : markdown;
  const head = match ? match[1] : "";
  const fields: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    id,
    name: fields.name ?? id,
    title: fields.title ?? id,
    role: body.trim(),
  };
}

export function formatIdentity(bot: BotIdentity): string {
  return `---\nname: ${bot.name}\ntitle: ${bot.title}\n---\n\n${bot.role.trim()}\n`;
}

export function listBots(): BotIdentity[] {
  const dir = botsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadBot(e.name))
    .filter((b): b is BotIdentity => Boolean(b));
}

export function loadBot(id: string): BotIdentity | undefined {
  const file = join(botPath(id), "identity.md");
  if (!existsSync(file)) return undefined;
  return parseIdentity(id, readFileSync(file, "utf8"));
}

export function saveBot(bot: BotIdentity): void {
  const dir = botPath(bot.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.md"), formatIdentity(bot));
  const memory = join(dir, "memory.md");
  if (!existsSync(memory)) {
    writeFileSync(
      memory,
      "# Memory\n\nPlan, decisions made, what's left.\n",
    );
  }
  mkdirSync(join(dir, "conversations"), { recursive: true });
}

export function loadMemory(id: string): string {
  const file = join(botPath(id), "memory.md");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

export function saveMemory(id: string, body: string): void {
  const dir = botPath(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.md"), body);
}

export interface Turn {
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  backendId?: string;
}

export interface Conversation {
  id: string;
  botId: string;
  startedAt: string;
  turns: Turn[];
}

export function conversationPath(botId: string, convId: string): string {
  return join(botPath(botId), "conversations", `${convId}.json`);
}

export function newConversation(botId: string): Conversation {
  const conv: Conversation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    botId,
    startedAt: new Date().toISOString(),
    turns: [],
  };
  mkdirSync(join(botPath(botId), "conversations"), { recursive: true });
  writeFileSync(conversationPath(botId, conv.id), `${JSON.stringify(conv, null, 2)}\n`);
  return conv;
}

export function loadConversation(botId: string, convId: string): Conversation {
  return JSON.parse(readFileSync(conversationPath(botId, convId), "utf8")) as Conversation;
}

export function appendTurn(conv: Conversation, turn: Turn): Conversation {
  conv.turns.push(turn);
  writeFileSync(conversationPath(conv.botId, conv.id), `${JSON.stringify(conv, null, 2)}\n`);
  return conv;
}

export function recentTranscript(conv: Conversation, maxTurns = 8): string {
  return conv.turns
    .slice(-maxTurns)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n\n");
}

export const DEFAULT_BOT: BotIdentity = {
  id: "builder",
  name: "builder",
  title: "Repo builder",
  role: `You are a coding agent running on this Mac through Truss.
Prefer small diffs. Keep memory.md current: plan, decisions made, what's left.
Do not redo work that is already correct.`,
};

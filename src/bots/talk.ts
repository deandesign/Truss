import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { backendFromPreset } from "../backends/registry.js";
import type { Backend } from "../backends/types.js";
import {
  appendTurn,
  DEFAULT_BOT,
  loadBot,
  loadMemory,
  newConversation,
  recentTranscript,
  saveBot,
} from "../bots/store.js";
import { loadConfig } from "../core/config.js";
import { formatReport } from "../core/report.js";
import { route } from "../core/router.js";
import { loadSkill, skillFromMessage } from "../skills/store.js";

export interface TalkOpts {
  botId?: string;
  message?: string;
  skill?: string;
  cwd: string;
  extraArgs?: string[];
  backends?: Backend[];
}

function resolveBackends(): Backend[] {
  const config = loadConfig();
  const byId = new Map(config.backends.map((p) => [p.id, backendFromPreset(p)]));
  return config.order
    .map((id) => byId.get(id))
    .filter((b): b is Backend => Boolean(b));
}

export async function talkOnce(opts: TalkOpts): Promise<string> {
  const bot = loadBot(opts.botId ?? DEFAULT_BOT.id) ?? DEFAULT_BOT;
  if (!loadBot(bot.id)) saveBot(bot);
  const conv = newConversation(bot.id);
  const raw = opts.message ?? "";
  const fromSlash = skillFromMessage(raw);
  const skill = opts.skill ? loadSkill(opts.skill) : fromSlash.skill;
  const message = fromSlash.rest || raw;
  appendTurn(conv, {
    role: "user",
    text: message,
    at: new Date().toISOString(),
  });
  const config = loadConfig();
  const manifest = await route({
    backends: opts.backends ?? resolveBackends(),
    task: { prompt: message, cwd: opts.cwd },
    autonomy: config.autonomy,
    identity: `${bot.name} — ${bot.title}\n\n${bot.role}`,
    memory: loadMemory(bot.id),
    skill: skill ? `${skill.title}\n\n${skill.body}` : undefined,
    transcript: recentTranscript(conv),
    extraArgs: opts.extraArgs,
  });
  const last = manifest.steps.at(-1);
  appendTurn(conv, {
    role: "assistant",
    text: last?.text ?? manifest.finalOutcome,
    at: new Date().toISOString(),
    backendId: last?.backendId,
  });
  return `${formatReport(manifest)}\n\n${last?.text ?? ""}`.trim();
}

export async function talkRepl(opts: TalkOpts): Promise<void> {
  const rl = createInterface({ input, output });
  const bot = loadBot(opts.botId ?? DEFAULT_BOT.id) ?? DEFAULT_BOT;
  console.log(`talking to ${bot.name} (${bot.title}). Ctrl-D to exit.`);
  try {
    while (true) {
      const line = await rl.question("> ");
      if (!line.trim()) continue;
      const text = await talkOnce({ ...opts, message: line, botId: bot.id });
      console.log(text);
    }
  } catch {
    // EOF
  } finally {
    rl.close();
  }
}

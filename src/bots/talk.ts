import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { backendFromPreset } from "../backends/registry.js";
import type { Backend } from "../backends/types.js";
import {
  appendTurn,
  DEFAULT_BOT,
  latestConversation,
  loadBot,
  loadConversation,
  loadMemory,
  newConversation,
  recentTranscript,
  saveBot,
  type Conversation,
} from "../bots/store.js";
import { loadConfig } from "../core/config.js";
import type { RunManifest } from "../core/manifest.js";
import { formatReport } from "../core/report.js";
import { route, type RouterEvent } from "../core/router.js";
import { harvestMemory } from "./harvest.js";
import { loadSkill, skillFromMessage } from "../skills/store.js";
import { createLiveView } from "../ui/live.js";

export interface TalkOpts {
  botId?: string;
  message?: string;
  skill?: string;
  cwd: string;
  extraArgs?: string[];
  backends?: Backend[];
  /** When supplied, the caller is rendering progress and gets only the reply. */
  onProgress?: (event: RouterEvent) => void;
  /** Append-only output instead of the live view. */
  plain?: boolean;
  /** Continue the most recent conversation for this bot. */
  continue?: boolean;
  /** Explicit conversation id to continue. */
  conversationId?: string;
  /** Reuse an already-open conversation (REPL). */
  conversation?: Conversation;
}

export interface TalkResult {
  text: string;
  manifest: RunManifest;
  conversation: Conversation;
}

function resolveBackends(): Backend[] {
  const config = loadConfig();
  const byId = new Map(config.backends.map((p) => [p.id, backendFromPreset(p)]));
  return config.order
    .map((id) => byId.get(id))
    .filter((b): b is Backend => Boolean(b));
}

function resolveConversation(
  botId: string,
  opts: TalkOpts,
): Conversation {
  if (opts.conversation) return opts.conversation;
  if (opts.conversationId) return loadConversation(botId, opts.conversationId);
  if (opts.continue) {
    const latest = latestConversation(botId);
    if (latest) return latest;
  }
  return newConversation(botId);
}

export async function talkOnce(opts: TalkOpts): Promise<TalkResult> {
  const bot = loadBot(opts.botId ?? DEFAULT_BOT.id) ?? DEFAULT_BOT;
  if (!loadBot(bot.id)) saveBot(bot);
  const conv = resolveConversation(bot.id, opts);
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
    budgets: config.budgets,
    identity: `${bot.name} — ${bot.title}\n\n${bot.role}`,
    memory: loadMemory(bot.id),
    skill: skill ? `${skill.title}\n\n${skill.body}` : undefined,
    transcript: recentTranscript(conv),
    extraArgs: opts.extraArgs,
    onProgress: opts.onProgress,
  });
  harvestMemory(opts.cwd, bot.id);

  const last = manifest.steps.at(-1);
  appendTurn(conv, {
    role: "assistant",
    text: last?.text ?? manifest.finalOutcome,
    at: new Date().toISOString(),
    backendId: last?.backendId,
  });
  const reply = (last?.text ?? "").trim();
  const text = opts.onProgress
    ? reply
    : `${formatReport(manifest)}\n\n${reply}`.trim();
  return { text, manifest, conversation: conv };
}

export async function talkRepl(opts: TalkOpts): Promise<void> {
  const rl = createInterface({ input, output });
  const bot = loadBot(opts.botId ?? DEFAULT_BOT.id) ?? DEFAULT_BOT;
  const conversation = newConversation(bot.id);
  console.log(
    `talking to ${bot.name} (${bot.title}) · conversation ${conversation.id}. Ctrl-D to exit.`,
  );
  try {
    while (true) {
      const line = await rl.question("> ");
      if (!line.trim()) continue;
      const view = createLiveView({ plain: opts.plain });
      const result = await talkOnce({
        ...opts,
        message: line,
        botId: bot.id,
        conversation,
        onProgress: (event) => view.onProgress(event),
      });
      view.close();
      if (result.text) console.log(`\n${result.text}\n`);
      if (result.manifest.finalOutcome !== "success") {
        process.exitCode = 1;
      }
    }
  } catch {
    // EOF
  } finally {
    rl.close();
  }
}

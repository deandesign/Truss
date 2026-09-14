import { Command } from "commander";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { backendFromPreset } from "../backends/registry.js";
import { listBots, loadBot, saveBot, DEFAULT_BOT, loadMemory } from "../bots/store.js";
import { talkOnce, talkRepl } from "../bots/talk.js";
import { loadConfig } from "../core/config.js";
import { initHome } from "../core/init.js";
import { loadLimits } from "../core/limits.js";
import { formatReport } from "../core/report.js";
import { route } from "../core/router.js";
import {
  installRoutine,
  listRoutines,
  loadRoutine,
  parseCron,
  saveRoutine,
  uninstallRoutine,
} from "../routines/launchd.js";
import { listSkills, loadSkill } from "../skills/store.js";
import { createLiveView } from "../ui/live.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

function cliJsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("truss")
    .description("A meta-harness that connects the coding agents you already pay for.")
    .version(version);

  program
    .command("init")
    .description("Create ~/.truss with a default bot and example skills")
    .action(() => {
      const home = initHome();
      console.log(`initialized ${home}`);
    });

  program
    .command("status")
    .description("Backend availability, auth, last-known limits")
    .action(async () => {
      initHome();
      const config = loadConfig();
      const limits = loadLimits();
      for (const id of config.order) {
        const preset = config.backends.find((b) => b.id === id);
        if (!preset) continue;
        const backend = backendFromPreset(preset);
        const avail = await backend.available();
        const state = limits[id];
        const bits = [
          id.padEnd(12),
          avail.installed ? "installed" : "missing",
          `auth=${String(avail.authed)}`,
          state?.at ? `limited@${state.at}` : "no known limit",
        ];
        console.log(bits.join("  "));
        if (avail.detail) console.log(`             ${avail.detail}`);
        const windows = state?.quota?.windows ?? [];
        if (windows.length) {
          const headroom = windows
            .map(
              (w) =>
                `${w.key.replace(/_/g, " ")} ${Math.round(w.utilization * 100)}% used`,
            )
            .join(", ");
          console.log(`             quota: ${headroom}`);
        }
      }
    });

  program
    .command("run")
    .description("Inner loop: run a task with quota failover")
    .argument("<task...>", "task prompt")
    .option("--cwd <path>", "working directory", process.cwd())
    .option("--plain", "append-only output instead of the live view")
    .action(async (task: string[], opts: { cwd: string; plain?: boolean }) => {
      initHome();
      const config = loadConfig();
      const backends = config.order
        .map((id) => config.backends.find((b) => b.id === id))
        .filter(Boolean)
        .map((p) => backendFromPreset(p!));
      const view = createLiveView({ plain: opts.plain });
      const manifest = await route({
        backends,
        task: { prompt: task.join(" "), cwd: opts.cwd },
        autonomy: config.autonomy,
        onProgress: (event) => view.onProgress(event),
      });
      view.close();
      const last = manifest.steps.at(-1);
      if (last?.text) console.log(`\n${last.text}`);
      if (manifest.finalOutcome !== "success") process.exitCode = 1;
    });

  program
    .command("talk")
    .description("Message a named bot")
    .argument("[bot]", "bot id", DEFAULT_BOT.id)
    .argument("[message...]", "message; omit to read stdin / start a REPL")
    .option("--skill <id>", "inject a skill pack")
    .option("--cwd <path>", "working directory", process.cwd())
    .option("--plain", "append-only output instead of the live view")
    .action(
      async (
        bot: string,
        message: string[],
        opts: { skill?: string; cwd: string; plain?: boolean },
      ) => {
        initHome();
        if (!loadBot(bot)) {
          const asMessage = [bot, ...message].join(" ").trim();
          bot = DEFAULT_BOT.id;
          message = asMessage ? asMessage.split(" ") : [];
        }
        const text = message.join(" ").trim();
        if (!text && process.stdin.isTTY) {
          await talkRepl({
            botId: bot,
            cwd: opts.cwd,
            skill: opts.skill,
            plain: opts.plain,
          });
          return;
        }
        const fromStdin = text || (await readStdin());
        const view = createLiveView({ plain: opts.plain });
        const out = await talkOnce({
          botId: bot,
          message: fromStdin,
          skill: opts.skill,
          cwd: opts.cwd,
          onProgress: (event) => view.onProgress(event),
        });
        view.close();
        if (out) console.log(`\n${out}`);
      },
    );

  const bots = program.command("bots").description("Manage bots");
  bots.command("list").action(() => {
    initHome();
    for (const bot of listBots()) {
      console.log(`${bot.id.padEnd(16)} ${bot.title}`);
    }
  });
  bots
    .command("show")
    .argument("<id>")
    .action((id: string) => {
      const bot = loadBot(id);
      if (!bot) {
        console.error(`no bot ${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${bot.name} — ${bot.title}\n\n${bot.role}\n\n--- memory ---\n${loadMemory(id)}`);
    });
  bots
    .command("create")
    .argument("<id>")
    .option("--title <title>", "short job title")
    .option("--role <role>", "operating instructions")
    .action((id: string, opts: { title?: string; role?: string }) => {
      initHome();
      saveBot({
        id,
        name: id,
        title: opts.title ?? id,
        role: opts.role ?? DEFAULT_BOT.role,
      });
      console.log(`created bot ${id}`);
    });

  const skills = program.command("skills").description("Shared markdown skills");
  skills.command("list").action(() => {
    initHome();
    for (const skill of listSkills()) {
      console.log(`${skill.id.padEnd(16)} ${skill.title}`);
    }
  });
  skills
    .command("show")
    .argument("<id>")
    .action((id: string) => {
      const skill = loadSkill(id);
      if (!skill) {
        console.error(`no skill ${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${skill.title}\n\n${skill.body}`);
    });

  const routines = program.command("routines").description("Local launchd routines (Mac must be awake)");
  routines.command("list").action(() => {
    initHome();
    for (const r of listRoutines()) {
      const when = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
      console.log(`${r.id.padEnd(16)} ${r.bot} @ ${when}  ${r.prompt}`);
    }
  });
  routines
    .command("create")
    .argument("<id>")
    .requiredOption("--bot <id>", "bot to run")
    .requiredOption("--prompt <text>", "message")
    .option("--skill <id>", "skill to inject")
    .option("--cron <expr>", "minute hour * * [weekday]", "0 9 * * *")
    .option("--cwd <path>", "working directory", process.cwd())
    .action(
      (
        id: string,
        opts: { bot: string; prompt: string; skill?: string; cron: string; cwd: string },
      ) => {
        initHome();
        const when = parseCron(opts.cron);
        saveRoutine({
          id,
          bot: opts.bot,
          prompt: opts.prompt,
          skill: opts.skill,
          cwd: opts.cwd,
          ...when,
        });
        console.log(`saved routine ${id} (not installed — run truss routines install ${id})`);
      },
    );
  routines
    .command("install")
    .argument("<id>")
    .description("Load a LaunchAgent. Only fires while this Mac is awake.")
    .action((id: string) => {
      initHome();
      const routine = loadRoutine(id);
      if (!routine) {
        console.error(`no routine ${id}`);
        process.exitCode = 1;
        return;
      }
      const path = installRoutine(routine, process.execPath, cliJsPath());
      console.log(`installed ${path}`);
      console.log("routines only run while this Mac is awake.");
    });
  routines
    .command("uninstall")
    .argument("<id>")
    .action((id: string) => {
      uninstallRoutine(id);
      console.log(`uninstalled ${id}`);
    });
  routines
    .command("run")
    .argument("<id>")
    .action(async (id: string) => {
      initHome();
      const routine = loadRoutine(id);
      if (!routine) {
        console.error(`no routine ${id}`);
        process.exitCode = 1;
        return;
      }
      const out = await talkOnce({
        botId: routine.bot,
        message: routine.prompt,
        skill: routine.skill,
        cwd: routine.cwd,
      });
      console.log(out);
    });

  return program;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { probeAuth } from "../backends/auth.js";
import {
  AUTONOMY_HELP,
  AUTONOMY_VALUES,
  loadConfig,
  saveConfig,
  setConfigValue,
  type TrussConfig,
} from "../core/config.js";
import { configPath } from "../core/paths.js";
import { pad, paletteFor } from "../ui/ansi.js";
import { configuredBackends } from "./auth-commands.js";

export interface Candidate {
  id: string;
  usable: boolean;
  detail?: string;
  signedIn: boolean | "unknown";
  email?: string;
  plan?: string;
}

/** Thrown when the user walks away — Ctrl+C, Ctrl+D, or an empty pipe. */
export class SetupCancelled extends Error {
  constructor() {
    super("setup cancelled — nothing saved");
    this.name = "SetupCancelled";
  }
}

/** `question` returns the typed answer, or the fallback when it's blank. */
export type Ask = (question: string, fallback: string) => Promise<string>;

export async function survey(): Promise<Candidate[]> {
  const backends = configuredBackends();
  return Promise.all(
    backends.map(async (backend): Promise<Candidate> => {
      const avail = await backend.available();
      if (!avail.usable) {
        return {
          id: backend.id,
          usable: false,
          detail: avail.detail,
          signedIn: false,
        };
      }
      const auth = await probeAuth(backend.dialect, backend.binary);
      return {
        id: backend.id,
        usable: true,
        signedIn: auth.authed,
        email: auth.account?.email,
        plan: auth.account?.plan,
      };
    }),
  );
}

/** Backends worth putting first: present, runnable, and not known to be signed out. */
export function readyOf(found: Candidate[]): Candidate[] {
  return found.filter((c) => c.usable && c.signedIn !== false);
}

export function suggestedOrder(found: Candidate[]): string[] {
  const ready = readyOf(found);
  const rest = found.filter((c) => !ready.includes(c));
  return [...ready.map((c) => c.id), ...rest.map((c) => c.id)];
}

/**
 * Ask the two questions and validate the answers against the same rules
 * `truss config set` uses, so the wizard cannot write something the CLI would
 * have refused.
 */
export async function chooseSetup(
  found: Candidate[],
  config: TrussConfig,
  ask: Ask,
): Promise<TrussConfig> {
  const suggested = suggestedOrder(found);
  const orderAnswer = await ask("order", suggested.join(","));
  let next = setConfigValue(config, "order", orderAnswer);
  const autonomyAnswer = await ask("autonomy", config.autonomy);
  next = setConfigValue(next, "autonomy", autonomyAnswer);
  return next;
}

function describe(c: Candidate, palette: ReturnType<typeof paletteFor>): string {
  if (!c.usable) {
    return palette.dim(
      c.detail ? "installed but will not run" : "not installed",
    );
  }
  if (c.signedIn === true) {
    const who = c.email ?? "signed in";
    return `${who}${c.plan ? palette.dim(` (${c.plan})`) : ""}`;
  }
  if (c.signedIn === false) {
    return palette.yellow(`not signed in — truss login ${c.id}`);
  }
  return palette.dim("sign-in state unknown");
}

function mark(c: Candidate, palette: ReturnType<typeof paletteFor>): string {
  if (!c.usable) return palette.dim("○");
  if (c.signedIn === false) return palette.yellow("◐");
  return palette.green("●");
}

export interface SetupOpts {
  /** Apply directly without prompting — scriptable, and works off a terminal. */
  order?: string;
  autonomy?: string;
}

export async function setupCmd(opts: SetupOpts = {}): Promise<void> {
  const palette = paletteFor(output);
  const config = loadConfig();

  console.log(`\n  ${palette.bold("truss setup")}\n`);
  console.log(`  ${palette.dim("Looking at your installed agent CLIs…")}\n`);

  const found = await survey();
  const width = Math.max(6, ...found.map((c) => c.id.length));
  for (const c of found) {
    console.log(
      `    ${mark(c, palette)} ${pad(c.id, width)}  ${describe(c, palette)}`,
    );
  }

  if (readyOf(found).length === 0) {
    console.log(
      `\n  ${palette.red("Nothing is ready to run.")} Install or sign in to at least one CLI, then run setup again.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Flags win over prompting, so setup can be scripted and run off a terminal.
  if (opts.order !== undefined || opts.autonomy !== undefined) {
    try {
      let next = config;
      if (opts.order !== undefined) {
        next = setConfigValue(next, "order", opts.order);
      }
      if (opts.autonomy !== undefined) {
        next = setConfigValue(next, "autonomy", opts.autonomy);
      }
      saveConfig(next);
      console.log(`\n  ${palette.green("Saved")} ${palette.dim(configPath())}`);
      console.log(`    order      ${next.order.join(" → ")}`);
      console.log(
        `    autonomy   ${next.autonomy}  ${palette.dim(AUTONOMY_HELP[next.autonomy])}\n`,
      );
    } catch (err) {
      console.log(
        `\n  ${palette.red(err instanceof Error ? err.message : String(err))}`,
      );
      console.log(`  ${palette.dim("nothing saved")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!input.isTTY) {
    console.log(
      `\n  ${palette.dim("not a terminal — pass --order / --autonomy, or run truss setup in a terminal")}\n`,
    );
    return;
  }

  const rl = createInterface({ input, output });
  const ask: Ask = async (question, fallback) => {
    let answer: string;
    try {
      answer = await rl.question(`  ${question} [${fallback}]: `);
    } catch {
      // readline rejects on EOF (Ctrl+D).
      throw new SetupCancelled();
    }
    return answer.trim() || fallback;
  };
  rl.on("SIGINT", () => rl.close());

  try {
    console.log(
      `\n  ${palette.bold("Failover order")} ${palette.dim("— first one with quota wins")}`,
    );
    console.log(
      `  ${palette.dim(`suggested: ${suggestedOrder(found).join(" → ")}`)}`,
    );
    console.log("");
    console.log(
      `  ${palette.bold("Autonomy")} ${palette.dim("— how much the agents may do unattended")}`,
    );
    for (const value of AUTONOMY_VALUES) {
      const current =
        value === config.autonomy ? palette.green(" (current)") : "";
      console.log(
        `    ${pad(value, 8)} ${palette.dim(AUTONOMY_HELP[value])}${current}`,
      );
    }
    console.log("");

    const next = await chooseSetup(found, config, ask);
    saveConfig(next);

    console.log(`\n  ${palette.green("Saved")} ${palette.dim(configPath())}`);
    console.log(`    order      ${next.order.join(" → ")}`);
    console.log(
      `    autonomy   ${next.autonomy}  ${palette.dim(AUTONOMY_HELP[next.autonomy])}`,
    );

    const needLogin = found.filter((c) => c.usable && c.signedIn === false);
    if (needLogin.length) {
      console.log(`\n  ${palette.yellow("Next:")} truss login ${needLogin[0].id}`);
    }
    console.log(
      `\n  ${palette.dim("Try it:")} truss run "what does this repo do?"\n`,
    );
  } catch (err) {
    if (err instanceof SetupCancelled) {
      console.log(`\n  ${palette.dim(err.message)}\n`);
      process.exitCode = 1;
      return;
    }
    // A rejected answer should not read as a crash.
    console.log(
      `\n  ${palette.red(err instanceof Error ? err.message : String(err))}`,
    );
    console.log(`  ${palette.dim("nothing saved")}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoTrussDir } from "../core/paths.js";
import { saveMemory } from "./store.js";

/**
 * Where a run is asked to leave its scratchpad.
 *
 * Inside the repo, so no backend needs write access outside its working
 * directory, and inside `.truss/` specifically so it cannot collide with a
 * `memory.md` the repo already keeps. Checkpoints already exclude `.truss/`,
 * so the drop never lands in a handoff diffstat either.
 */
export function memoryDropPath(cwd: string): string {
  return join(repoTrussDir(cwd), "memory.md");
}

/**
 * Move a run's scratchpad into the bot's durable store, then remove it.
 *
 * The bot's real memory lives in `~/.truss/bots/<id>/memory.md`, which is
 * outside the repo and so out of reach of a sandboxed backend. Rather than
 * granting every run write access to the Truss home, the agent writes inside
 * the repo and Truss carries it the rest of the way.
 *
 * Returns whether anything was persisted.
 */
export function harvestMemory(cwd: string, botId: string): boolean {
  const path = memoryDropPath(cwd);
  if (!existsSync(path)) return false;

  let body = "";
  try {
    body = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  // Always clear the drop: leaving it would let one bot's notes be read back
  // into another the next time a run happens in this repo.
  rmSync(path, { force: true });

  // An empty scratchpad is not an instruction to forget everything.
  if (!body) return false;

  saveMemory(botId, `${body}\n`);
  return true;
}

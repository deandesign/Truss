import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BOT, saveBot } from "../bots/store.js";
import { DEFAULT_CONFIG, saveConfig } from "../core/config.js";
import { trussHome } from "../core/paths.js";
import { DEFAULT_SKILLS, saveSkill } from "../skills/store.js";

export function initHome(): string {
  const home = trussHome();
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "bots"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  mkdirSync(join(home, "routines"), { recursive: true });
  if (!existsSync(join(home, "config.json"))) saveConfig(DEFAULT_CONFIG);
  if (!existsSync(join(home, "bots", DEFAULT_BOT.id, "identity.md"))) {
    saveBot(DEFAULT_BOT);
  }
  for (const skill of DEFAULT_SKILLS) {
    if (!existsSync(join(home, "skills", `${skill.id}.md`))) saveSkill(skill);
  }
  writeFileSync(
    join(home, "README.md"),
    "Local Truss home. Bots, skills, routines, and last-known limits live here.\n",
  );
  return home;
}

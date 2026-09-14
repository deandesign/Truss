import { homedir } from "node:os";
import { join } from "node:path";

export function trussHome(): string {
  return process.env.TRUSS_HOME ?? join(homedir(), ".truss");
}

export function repoTrussDir(cwd = process.cwd()): string {
  return join(cwd, ".truss");
}

export function botsDir(): string {
  return join(trussHome(), "bots");
}

export function skillsDir(): string {
  return join(trussHome(), "skills");
}

export function routinesDir(): string {
  return join(trussHome(), "routines");
}

export function limitsPath(): string {
  return join(trussHome(), "state", "limits.json");
}

export function configPath(): string {
  return join(trussHome(), "config.json");
}

export function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

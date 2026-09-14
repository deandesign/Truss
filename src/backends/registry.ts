import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { CursorBackend } from "./cursor.js";
import type { Backend, BackendPreset } from "./types.js";

export function backendFromPreset(preset: BackendPreset): Backend {
  const args = [
    ...(preset.model ? modelArgs(preset.binary, preset.model) : []),
    ...(preset.defaultArgs ?? []),
  ];
  if (preset.binary === "cursor-agent" || preset.id.startsWith("cursor")) {
    return new CursorBackend(preset.id, preset.binary, args);
  }
  if (preset.binary === "codex" || preset.id.startsWith("codex")) {
    return new CodexBackend(preset.id, preset.binary, args);
  }
  return new ClaudeBackend(preset.id, preset.binary, args);
}

function modelArgs(binary: string, model: string): string[] {
  if (binary === "codex") return ["-c", `model=${model}`];
  return ["--model", model];
}

export const DEFAULT_PRESETS: BackendPreset[] = [
  { id: "claude", binary: "claude" },
  { id: "cursor", binary: "cursor-agent" },
  { id: "codex", binary: "codex" },
];

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launchAgentsDir, routinesDir } from "../core/paths.js";

export interface Routine {
  id: string;
  bot: string;
  prompt: string;
  skill?: string;
  cwd: string;
  hour: number;
  minute: number;
  weekday?: number;
  weekdays?: number[];
}

export function routinePath(id: string): string {
  return join(routinesDir(), `${id}.json`);
}

export function plistPath(id: string): string {
  return join(launchAgentsDir(), `com.truss.routine.${id}.plist`);
}

export function listRoutines(): Routine[] {
  const dir = routinesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Routine);
}

export function loadRoutine(id: string): Routine | undefined {
  const file = routinePath(id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Routine;
}

export function saveRoutine(routine: Routine): void {
  mkdirSync(routinesDir(), { recursive: true });
  writeFileSync(routinePath(routine.id), `${JSON.stringify(routine, null, 2)}\n`);
}

function parseWeekdays(field: string): number[] | undefined {
  if (field === "*") return undefined;
  const days: number[] = [];
  for (const part of field.split(",")) {
    const range = part.split("-").map(Number);
    if (range.some((n) => Number.isNaN(n))) continue;
    if (range.length === 2) {
      const [start, end] = range;
      for (let d = start; d <= end; d++) days.push(d);
    } else if (range[0] !== undefined) {
      days.push(range[0]);
    }
  }
  return days.length ? days : undefined;
}

export function parseCron(
  expr: string,
): Pick<Routine, "hour" | "minute" | "weekday" | "weekdays"> {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`expected 5-field cron, got: ${expr}`);
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (Number.isNaN(minute) || Number.isNaN(hour)) {
    throw new Error(`unsupported cron (use minute hour * * [weekday]): ${expr}`);
  }
  const weekdays = parseWeekdays(parts[4]);
  return {
    minute,
    hour,
    weekday: weekdays?.length === 1 ? weekdays[0] : undefined,
    weekdays: weekdays && weekdays.length > 1 ? weekdays : undefined,
  };
}

function calendarDict(hour: number, minute: number, weekday?: number): string {
  const weekdayLine =
    weekday !== undefined
      ? `\n        <key>Weekday</key><integer>${weekday}</integer>`
      : "";
  return `      <dict>
        <key>Hour</key><integer>${hour}</integer>
        <key>Minute</key><integer>${minute}</integer>${weekdayLine}
      </dict>`;
}

export function renderPlist(routine: Routine, node: string, cli: string): string {
  const days =
    routine.weekdays ??
    (routine.weekday !== undefined ? [routine.weekday] : [undefined]);
  const dicts = days.map((day) => calendarDict(routine.hour, routine.minute, day));
  const calendar =
    dicts.length === 1
      ? `    <key>StartCalendarInterval</key>\n${dicts[0]}`
      : `    <key>StartCalendarInterval</key>\n    <array>\n${dicts.join("\n")}\n    </array>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.truss.routine.${routine.id}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(node)}</string>
      <string>${escapeXml(cli)}</string>
      <string>routines</string>
      <string>run</string>
      <string>${escapeXml(routine.id)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(routine.cwd)}</string>
${calendar}
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(routinesDir(), `${routine.id}.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(routinesDir(), `${routine.id}.err`))}</string>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function installRoutine(
  routine: Routine,
  node: string,
  cli: string,
): string {
  saveRoutine(routine);
  mkdirSync(launchAgentsDir(), { recursive: true });
  const path = plistPath(routine.id);
  writeFileSync(path, renderPlist(routine, node, cli));
  try {
    execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["load", path]);
  return path;
}

export function uninstallRoutine(id: string): void {
  const path = plistPath(id);
  try {
    execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
  } catch {
    // ignore
  }
  if (existsSync(path)) unlinkSync(path);
}

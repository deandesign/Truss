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
import { writeJsonAtomic } from "../core/atomic.js";
import { assertSafeId } from "../core/ids.js";
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
  return join(routinesDir(), `${assertSafeId("routine", id)}.json`);
}

export function plistPath(id: string): string {
  return join(launchAgentsDir(), `com.truss.routine.${assertSafeId("routine", id)}.plist`);
}

export function listRoutines(): Routine[] {
  const dir = routinesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as Routine;
      } catch (err) {
        throw new Error(
          `corrupt routine ${f}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

export function loadRoutine(id: string): Routine | undefined {
  const file = routinePath(id);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Routine;
  } catch (err) {
    throw new Error(
      `corrupt routine ${id}: ${err instanceof Error ? err.message : String(err)} — fix or delete ${file}`,
    );
  }
}

export function saveRoutine(routine: Routine): void {
  assertSafeId("routine", routine.id);
  assertSafeId("bot", routine.bot);
  if (routine.skill) assertSafeId("skill", routine.skill);
  if (
    !Number.isInteger(routine.hour) ||
    routine.hour < 0 ||
    routine.hour > 23
  ) {
    throw new Error(`routine hour must be 0–23 (got ${routine.hour})`);
  }
  if (
    !Number.isInteger(routine.minute) ||
    routine.minute < 0 ||
    routine.minute > 59
  ) {
    throw new Error(`routine minute must be 0–59 (got ${routine.minute})`);
  }
  const days = routine.weekdays ?? (routine.weekday !== undefined ? [routine.weekday] : []);
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 7) {
      throw new Error(`routine weekday must be 0–7 (got ${d})`);
    }
  }
  mkdirSync(routinesDir(), { recursive: true });
  writeJsonAtomic(routinePath(routine.id), routine);
}

function parseWeekdays(field: string): number[] | undefined {
  if (field === "*") return undefined;
  const days: number[] = [];
  for (const part of field.split(",")) {
    const range = part.split("-").map(Number);
    if (range.some((n) => Number.isNaN(n))) {
      throw new Error(`invalid weekday field: ${field}`);
    }
    if (range.length === 2) {
      const [start, end] = range;
      if (start > end) throw new Error(`invalid weekday range: ${part}`);
      for (let d = start; d <= end; d++) days.push(d);
    } else if (range[0] !== undefined) {
      days.push(range[0]);
    }
  }
  for (const d of days) {
    if (d < 0 || d > 7) throw new Error(`weekday out of range: ${d}`);
  }
  return days.length ? days : undefined;
}

export function parseCron(
  expr: string,
): Pick<Routine, "hour" | "minute" | "weekday" | "weekdays"> {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5-field cron, got ${parts.length} fields: ${expr}`);
  }
  if (parts[2] !== "*" || parts[3] !== "*") {
    throw new Error(
      `unsupported cron (day-of-month and month must be *): ${expr}`,
    );
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`minute must be 0–59 (got ${parts[0]})`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`hour must be 0–23 (got ${parts[1]})`);
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

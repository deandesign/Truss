import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write via temp + rename so a crash mid-write cannot leave half a JSON file. */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

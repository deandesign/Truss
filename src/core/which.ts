import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function which(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [binary]);
    const path = stdout.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

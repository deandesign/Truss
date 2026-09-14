import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
  });
  return stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function diffstat(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return "";
  try {
    return await git(cwd, ["diff", "--stat"]);
  } catch {
    return "";
  }
}

export async function checkpoint(
  cwd: string,
  runId: string,
  seq: number,
): Promise<string | undefined> {
  if (!(await isGitRepo(cwd))) return undefined;
  const indexDir = mkdtempSync(join(tmpdir(), "truss-index-"));
  const indexFile = join(indexDir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    await git(cwd, ["add", "-A"], env);
    const tree = await git(cwd, ["write-tree"], env);
    let parent: string | undefined;
    try {
      parent = await git(cwd, ["rev-parse", "HEAD"]);
    } catch {
      parent = undefined;
    }
    const args = ["commit-tree", tree, "-m", `truss checkpoint ${runId} ${seq}`];
    if (parent) args.splice(2, 0, "-p", parent);
    const commit = await git(cwd, args);
    await git(cwd, ["update-ref", `refs/truss/${runId}/${seq}`, commit]);
    return commit;
  } catch {
    return undefined;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

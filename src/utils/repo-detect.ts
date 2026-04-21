import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function detectRepoRoot(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });

    return result.stdout.trim();
  } catch {
    throw new Error("Craig must be run inside a git repository.");
  }
}

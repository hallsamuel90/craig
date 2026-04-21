import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandExecutionOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function runCommand(
  file: string,
  args: string[],
  options: CommandExecutionOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isExecError(error)) {
      const details = error.stderr?.trim() || error.stdout?.trim() || error.message;
      throw new Error(`${file} ${args.join(" ")} failed: ${details}`);
    }

    throw error;
  }
}

export async function runCommandAllowingFailure(
  file: string,
  args: string[],
  options: CommandExecutionOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (isExecError(error)) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: typeof error.code === "number" ? error.code : null,
      };
    }

    throw error;
  }
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error;
}

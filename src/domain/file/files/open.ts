import { access, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

import { CraigError } from "../../error/index.js";

export async function resolveOpenFilePath(cwd: string, input: string): Promise<string> {
  const resolvedPath = path.resolve(cwd, input);
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
    await access(resolvedPath, constants.R_OK);
  } catch (error) {
    throw new CraigError("CLI_USAGE", `File is not readable: ${resolvedPath}`, {
      cause: error,
      details: { path: resolvedPath },
    });
  }

  if (!fileStat.isFile()) {
    throw new CraigError("CLI_USAGE", `Path is not a regular file: ${resolvedPath}`, {
      details: { path: resolvedPath },
    });
  }

  return resolvedPath;
}

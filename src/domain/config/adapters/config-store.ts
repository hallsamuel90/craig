import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const isFileMissingError = (error: unknown): error is { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code === "ENOENT";

export const readConfigFile = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
};

export const writeConfigFile = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
};

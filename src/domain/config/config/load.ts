import type { CraigPaths } from "../../../state/craig-paths.js";
import { readConfigFile } from "../adapters/config-store.js";
import type { CraigConfig } from "../types.js";
import { validate } from "./validate.js";

export const load = async (paths: CraigPaths): Promise<CraigConfig> => {
  const raw = await readConfigFile(paths.configFile);

  if (!raw) {
    return {};
  }

  if (raw.trimStart()[0] !== "{") {
    throw new Error(
      `Craig config at ${paths.configFile} is malformed. Remove or repair the file before rerunning Craig.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Craig config at ${paths.configFile} is malformed. Remove or repair the file before rerunning Craig.`,
    );
  }

  return validate(parsed, paths.configFile);
};

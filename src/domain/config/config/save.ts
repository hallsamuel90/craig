import type { CraigPaths } from "../../../state/craig-paths.js";
import { writeConfigFile } from "../adapters/config-store.js";
import type { CraigConfig } from "../types.js";
import { validate } from "./validate.js";

interface Deps {
  writeConfigFile: (filePath: string, content: string) => Promise<void>;
}

export const save = async (paths: CraigPaths, config: CraigConfig, deps: Deps = { writeConfigFile }): Promise<void> => {
  validate(config, paths.configFile);
  await deps.writeConfigFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
};

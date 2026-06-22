import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandListReposResult } from "../../../types/command.js";
import { listRepos } from "../adapters/repo-store.js";

export const listRegisteredRepos = async (
  paths: CraigPaths,
  deps: { listRepos: typeof listRepos } = { listRepos },
): Promise<CommandListReposResult> => {
  return { kind: "listRepos", repos: await deps.listRepos(paths) };
};

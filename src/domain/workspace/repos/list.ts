import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandListReposResult } from "../../../commands/types.js";
import { listRepos } from "../adapters/repo-store.js";
import { ensureCraigState } from "../workspaces/ensure.js";

export const listRegisteredRepos = async (
  paths: CraigPaths,
  deps: { listRepos: typeof listRepos; ensureCraigState: typeof ensureCraigState } = { listRepos, ensureCraigState },
): Promise<CommandListReposResult> => {
  await deps.ensureCraigState(paths.workspaceRoot);
  return { kind: "listRepos", repos: await deps.listRepos(paths) };
};

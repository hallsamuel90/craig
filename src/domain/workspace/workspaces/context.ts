import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CraigError } from "../../error/index.js";
import { getCraigPaths } from "../../../state/craig-paths.js";
import { validateCraigIndex } from "../adapters/index-store.js";
import { getGitCommonWorktreeRoot } from "../adapters/git.js";
import type { ResolvedWorkspaceContext, WorkspaceContextSource } from "../types.js";

export interface ResolveWorkspaceContextInput {
  cwd: string;
  explicitWorkspaceRoot?: string;
  environmentWorkspaceRoot?: string;
  allowUninitializedCwd?: boolean;
}

export async function resolveWorkspaceContext(
  input: ResolveWorkspaceContextInput,
): Promise<ResolvedWorkspaceContext> {
  const cwd = await normalizeDirectory(input.cwd, "Current working directory");

  if (input.explicitWorkspaceRoot !== undefined) {
    return resolvePreferredRoot(input.explicitWorkspaceRoot, "explicit", cwd, input.allowUninitializedCwd ?? false);
  }

  if (input.environmentWorkspaceRoot !== undefined) {
    return resolvePreferredRoot(input.environmentWorkspaceRoot, "environment", cwd, input.allowUninitializedCwd ?? false);
  }

  const ancestor = await findInitializedWorkspace(cwd);
  if (ancestor) {
    return { workspaceRoot: ancestor, source: "ancestor", initialized: true };
  }

  const gitCommonRoot = await getGitCommonWorktreeRoot(cwd);
  if (gitCommonRoot) {
    const gitWorkspace = await findInitializedWorkspace(gitCommonRoot);
    if (gitWorkspace) {
      return { workspaceRoot: gitWorkspace, source: "git_common_dir", initialized: true };
    }
  }

  if (input.allowUninitializedCwd) {
    return { workspaceRoot: cwd, source: "cwd", initialized: false };
  }

  throw new CraigError(
    "WORKSPACE_CONTEXT_NOT_FOUND",
    `No Craig workspace was found from ${cwd}. Use --workspace-root <path> or run Craig inside an initialized workspace.`,
    { details: { cwd } },
  );
}

async function resolvePreferredRoot(
  value: string,
  source: Extract<WorkspaceContextSource, "explicit" | "environment">,
  cwd: string,
  allowUninitialized: boolean,
): Promise<ResolvedWorkspaceContext> {
  const label = source === "explicit" ? "Workspace root" : "CRAIG_WORKSPACE_ROOT";
  const workspaceRoot = await normalizeDirectory(path.resolve(cwd, value), label);
  const initializedRoot = await getInitializedWorkspaceRoot(workspaceRoot);

  if (initializedRoot) {
    return { workspaceRoot: initializedRoot, source, initialized: true };
  }

  if (allowUninitialized) {
    return { workspaceRoot, source, initialized: false };
  }

  throw new CraigError(
    "WORKSPACE_CONTEXT_NOT_FOUND",
    `${label} ${workspaceRoot} is not an initialized Craig workspace.`,
    { details: { workspaceRoot, source } },
  );
}

async function findInitializedWorkspace(startPath: string): Promise<string | null> {
  let candidate = startPath;

  while (true) {
    const initializedRoot = await getInitializedWorkspaceRoot(candidate);
    if (initializedRoot) {
      return initializedRoot;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

async function getInitializedWorkspaceRoot(workspaceRoot: string): Promise<string | null> {
  const paths = getCraigPaths(workspaceRoot);

  try {
    const raw = await readFile(paths.indexFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const candidateRoot =
      typeof parsed === "object" &&
      parsed !== null &&
      "workspaceRoot" in parsed &&
      typeof parsed.workspaceRoot === "string"
        ? parsed.workspaceRoot
        : workspaceRoot;
    const index = validateCraigIndex(parsed, candidateRoot, paths.indexFile);
    const indexedRoot = await realpath(index.workspaceRoot).catch(() => path.resolve(index.workspaceRoot));
    if (indexedRoot !== workspaceRoot) {
      throw new Error(
        `Craig index at ${paths.indexFile} belongs to ${index.workspaceRoot}, not ${workspaceRoot}. Remove or repair the file before rerunning Craig.`,
      );
    }
    return index.workspaceRoot;
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }

    if (error instanceof CraigError) {
      throw error;
    }

    throw new CraigError(
      "WORKSPACE_CONTEXT_INVALID",
      error instanceof Error ? error.message : `Craig workspace at ${workspaceRoot} is invalid.`,
      { details: { workspaceRoot }, cause: error },
    );
  }
}

async function normalizeDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);

  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new CraigError(
        "WORKSPACE_CONTEXT_INVALID",
        `${label} ${resolved} is not a directory.`,
        { details: { path: resolved } },
      );
    }
    return await realpath(resolved);
  } catch (error) {
    if (error instanceof CraigError) {
      throw error;
    }

    throw new CraigError(
      "WORKSPACE_CONTEXT_NOT_FOUND",
      `${label} ${resolved} does not exist or cannot be read.`,
      { details: { path: resolved }, cause: error },
    );
  }
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

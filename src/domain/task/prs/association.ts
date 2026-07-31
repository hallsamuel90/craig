import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import {
  discoverPrViewForCommand,
  ensureGhAuthenticated,
  fetchPrView,
  getGitHubRepositoryLocator,
  parseGitHubPullRequestUrl,
  type GhPrView,
  type GitHubPullRequestLocator,
  type GitHubRepositoryLocator,
} from "../adapters/github.js";
import { writeTask } from "../adapters/task-store.js";
import { withTaskLock } from "../adapters/task-lock.js";
import { getTask } from "../tasks/inspect.js";
import type {
  CommandTaskPrResult,
  ProjectTaskRepoTarget,
  TaskPR,
  TaskPullRequest,
  TaskRecord,
} from "../types.js";
import { deriveTaskStatusFromPrs, getTaskPrimaryPr, isSamePullRequest, normalizePr, upsertTaskPr } from "./state.js";
import { persistTaskAndPrStatus, writePrStatusArtifact } from "./refresh.js";
import { deriveProjectTaskStatus } from "./project-persistence.js";

interface AssociationTarget {
  repoId: string;
  branch: string;
  worktreePath: string;
  repository: GitHubRepositoryLocator;
  projectTarget: ProjectTaskRepoTarget | null;
}

interface AssociationDependencies {
  readTask: typeof getTask;
  writeTask: typeof writeTask;
  withTaskLock: typeof withTaskLock;
  ensureGhAuthenticated: typeof ensureGhAuthenticated;
  fetchPrView: typeof fetchPrView;
  discoverPrView: typeof discoverPrViewForCommand;
  getGitHubRepositoryLocator: typeof getGitHubRepositoryLocator;
  writePrStatusArtifact: typeof writePrStatusArtifact;
}

const defaultDependencies: AssociationDependencies = {
  readTask: getTask,
  writeTask,
  withTaskLock,
  ensureGhAuthenticated,
  fetchPrView,
  discoverPrView: discoverPrViewForCommand,
  getGitHubRepositoryLocator,
  writePrStatusArtifact,
};

export async function showTaskPullRequests(
  paths: CraigPaths,
  taskId: string,
  repoId?: string,
  deps: AssociationDependencies = defaultDependencies,
): Promise<CommandTaskPrResult> {
  const task = await deps.readTask(paths, taskId);
  const target = await resolveShowTarget(task, repoId, deps);
  return buildResult(task, target, "showTaskPr", "shown", []);
}

export async function discoverTaskPullRequest(
  paths: CraigPaths,
  taskId: string,
  repoId?: string,
  deps: AssociationDependencies = defaultDependencies,
): Promise<CommandTaskPrResult> {
  return deps.withTaskLock(paths, taskId, async () => {
    const task = await deps.readTask(paths, taskId);
    const target = await resolveAssociationTarget(task, repoId, null, deps);
    await authenticate(target, deps);
    const view = await callGitHub(
      `discover a pull request for ${target.branch}`,
      () => deps.discoverPrView(target.branch, target.worktreePath),
    );
    if (!view) {
      return buildResult(task, target, "discoverTaskPr", "not_found", []);
    }
    assertPullRequestMatchesTarget(view, target);
    const existing = findPullRequest(task, target, view.number);
    const persisted = await persistAssociation(paths, task, target, view, deps);
    return buildResult(
      persisted,
      target,
      "discoverTaskPr",
      existing ? "synced" : "discovered",
      [],
    );
  });
}

export async function linkTaskPullRequest(
  paths: CraigPaths,
  taskId: string,
  selectorValue: string,
  repoId?: string,
  deps: AssociationDependencies = defaultDependencies,
): Promise<CommandTaskPrResult> {
  const selector = parsePullRequestSelector(selectorValue);
  return deps.withTaskLock(paths, taskId, async () => {
    const task = await deps.readTask(paths, taskId);
    const target = await resolveAssociationTarget(task, repoId, selector.repository, deps);
    assertSelectorMatchesTarget(selector.repository, target);
    await authenticate(target, deps);
    const view = await callGitHub(
      `fetch pull request ${selectorValue}`,
      () => deps.fetchPrView(selectorValue, target.worktreePath),
    );
    assertPullRequestMatchesSelector(view, selector);
    assertPullRequestMatchesTarget(view, target);

    const existing = findPullRequest(task, target, view.number);
    const current = getPrimaryPullRequest(task, target);
    const warnings = current && !isSamePullRequest(current, {
      owner: target.repository.owner,
      repo: target.repository.name,
      number: view.number,
    }) && current.status !== "closed" && current.status !== "merged"
      ? [`Pull request #${view.number} becomes active; #${current.number} remains in task history.`]
      : [];
    const persisted = await persistAssociation(paths, task, target, view, deps);
    return buildResult(
      persisted,
      target,
      "linkTaskPr",
      existing ? "unchanged" : "linked",
      warnings,
    );
  });
}

async function resolveUnlinkTarget(
  task: TaskRecord,
  repoId: string | undefined,
  selector: ParsedPullRequestSelector,
  deps: AssociationDependencies,
): Promise<AssociationTarget> {
  if (task.type === "repo") {
    if (repoId && repoId !== task.repoId) {
      throw targetConflict(task, repoId);
    }
    const persisted = task.prs.find((pr) => pr.number === selector.number) ?? getTaskPrimaryPr(task);
    return {
      repoId: task.repoId,
      branch: task.branch,
      worktreePath: task.worktreePath,
      repository: await resolvePersistedOrLocalRepository(
        persisted,
        task.worktreePath,
        task.repoId,
        deps,
      ),
      projectTarget: null,
    };
  }

  if (repoId) {
    const projectTarget = task.repoTargets?.find((candidate) => candidate.repoId === repoId);
    if (!projectTarget) {
      throw targetConflict(task, repoId);
    }
    const mirroredRepository = getPersistedRepository(projectTarget.pullRequest);
    const persisted = task.prs.find((pr) =>
      pr.number === selector.number &&
      (!pr.headBranch || pr.headBranch === projectTarget.branch) &&
      (!mirroredRepository || Boolean(pr.owner && pr.repo && sameRepository(
        { owner: pr.owner, name: pr.repo },
        mirroredRepository,
      )))
    ) ?? projectTarget.pullRequest;
    return {
      repoId,
      branch: projectTarget.branch,
      worktreePath: projectTarget.worktreePath,
      repository: await resolvePersistedOrLocalRepository(
        persisted,
        projectTarget.worktreePath,
        repoId,
        deps,
      ),
      projectTarget,
    };
  }
  if (!selector.repository) {
    throw new CraigError(
      "CLI_USAGE",
      `Project task ${task.id} requires --repo <repo-id> for a numeric pull request selector.`,
      { details: { taskId: task.id, pullRequestNumber: selector.number } },
    );
  }
  const repository = selector.repository;

  const matches: AssociationTarget[] = [];
  for (const target of task.repoTargets ?? []) {
    const mirrorMatches = target.pullRequest.owner && target.pullRequest.repo && sameRepository(
      { owner: target.pullRequest.owner, name: target.pullRequest.repo },
      repository,
    );
    const historyMatches = task.prs.some((pr) =>
      pr.number === selector.number &&
      pr.owner && pr.repo &&
      sameRepository({ owner: pr.owner, name: pr.repo }, repository) &&
      (!pr.headBranch || pr.headBranch === target.branch)
    );
    if (mirrorMatches || historyMatches) {
      matches.push({
        repoId: target.repoId,
        branch: target.branch,
        worktreePath: target.worktreePath,
        repository,
        projectTarget: target,
      });
    }
  }
  if (matches.length !== 1) {
    throw new CraigError(
      "TASK_CONTEXT_AMBIGUOUS",
      `Pull request repository ${selector.repository.owner}/${selector.repository.name} does not map to exactly one target in project task ${task.id}.`,
      {
        details: {
          taskId: task.id,
          owner: selector.repository.owner,
          repo: selector.repository.name,
          matchingRepoIds: matches.map((target) => target.repoId),
        },
      },
    );
  }
  return matches[0]!;
}

export async function refreshTaskPullRequest(
  paths: CraigPaths,
  taskId: string,
  repoId?: string,
  deps: AssociationDependencies = defaultDependencies,
): Promise<CommandTaskPrResult> {
  return deps.withTaskLock(paths, taskId, async () => {
    const task = await deps.readTask(paths, taskId);
    const target = await resolveAssociationTarget(task, repoId, null, deps);
    const current = getPrimaryPullRequest(task, target);
    if (!current?.number) {
      return buildResult(task, target, "refreshTaskPr", "not_found", []);
    }
    await authenticate(target, deps);
    const view = await callGitHub(
      `refresh pull request #${current.number}`,
      () => deps.fetchPrView(String(current.number), target.worktreePath),
    );
    assertPullRequestMatchesTarget(view, target);
    const persisted = await persistAssociation(paths, task, target, view, deps);
    return buildResult(persisted, target, "refreshTaskPr", "synced", []);
  });
}

export async function unlinkTaskPullRequest(
  paths: CraigPaths,
  taskId: string,
  selectorValue: string,
  repoId?: string,
  deps: AssociationDependencies = defaultDependencies,
): Promise<CommandTaskPrResult> {
  const selector = parsePullRequestSelector(selectorValue);
  return deps.withTaskLock(paths, taskId, async () => {
    const task = await deps.readTask(paths, taskId);
    const target = await resolveUnlinkTarget(task, repoId, selector, deps);
    assertSelectorMatchesTarget(selector.repository, target);
    const existing = findPullRequest(task, target, selector.number);
    if (!existing) {
      return buildResult(task, target, "unlinkTaskPr", "unchanged", []);
    }

    const withoutPr = removeAssociation(task, target, selector.number);
    const persisted = await persistTaskAndArtifact(paths, withoutPr, deps);
    return buildResult(persisted, target, "unlinkTaskPr", "unlinked", []);
  });
}

interface ParsedPullRequestSelector {
  number: number;
  repository: GitHubPullRequestLocator | null;
}

export function parsePullRequestSelector(value: string): ParsedPullRequestSelector {
  const trimmed = value.trim();
  const url = parseGitHubPullRequestUrl(trimmed);
  if (url) {
    return { number: url.number, repository: url };
  }
  if (/^[1-9]\d*$/.test(trimmed)) {
    return { number: Number(trimmed), repository: null };
  }
  throw new CraigError(
    "CLI_USAGE",
    `Invalid pull request selector "${value}". Use a GitHub pull request URL or positive number.`,
    { details: { selector: value } },
  );
}

async function resolveAssociationTarget(
  task: TaskRecord,
  repoId: string | undefined,
  selectorRepository: GitHubRepositoryLocator | null,
  deps: AssociationDependencies,
): Promise<AssociationTarget> {
  if (task.type === "repo") {
    if (repoId && repoId !== task.repoId) {
      throw targetConflict(task, repoId);
    }
    return buildTarget(task.repoId, task.branch, task.worktreePath, null, deps);
  }

  const targets = task.repoTargets ?? [];
  if (repoId) {
    const target = targets.find((candidate) => candidate.repoId === repoId);
    if (!target) {
      throw targetConflict(task, repoId);
    }
    return buildTarget(target.repoId, target.branch, target.worktreePath, target, deps);
  }
  if (!selectorRepository) {
    throw new CraigError(
      "CLI_USAGE",
      `Project task ${task.id} requires --repo <repo-id> for pull request commands.`,
      { details: { taskId: task.id, repoIds: targets.map((target) => target.repoId) } },
    );
  }

  const matches: AssociationTarget[] = [];
  for (const target of targets) {
    const resolved = await buildTarget(
      target.repoId,
      target.branch,
      target.worktreePath,
      target,
      deps,
    ).catch((error: unknown) => {
      if (
        error instanceof CraigError &&
        error.code === "EXTERNAL_DEPENDENCY_FAILED" &&
        error.message.includes("does not have a supported GitHub origin remote")
      ) {
        return null;
      }
      throw error;
    });
    if (!resolved) {
      continue;
    }
    if (sameRepository(resolved.repository, selectorRepository)) {
      matches.push(resolved);
    }
  }
  if (matches.length !== 1) {
    throw new CraigError(
      "TASK_CONTEXT_AMBIGUOUS",
      `Pull request repository ${selectorRepository.owner}/${selectorRepository.name} does not map to exactly one target in project task ${task.id}.`,
      {
        details: {
          taskId: task.id,
          owner: selectorRepository.owner,
          repo: selectorRepository.name,
          matchingRepoIds: matches.map((target) => target.repoId),
        },
      },
    );
  }
  return matches[0]!;
}

async function resolveShowTarget(
  task: TaskRecord,
  repoId: string | undefined,
  deps: AssociationDependencies,
): Promise<AssociationTarget> {
  if (task.type === "repo") {
    if (repoId && repoId !== task.repoId) {
      throw targetConflict(task, repoId);
    }
    const primary = getTaskPrimaryPr(task);
    return {
      repoId: task.repoId,
      branch: task.branch,
      worktreePath: task.worktreePath,
      repository: await resolvePersistedOrLocalRepository(
        primary,
        task.worktreePath,
        task.repoId,
        deps,
      ),
      projectTarget: null,
    };
  }

  if (!repoId) {
    throw new CraigError(
      "CLI_USAGE",
      `Project task ${task.id} requires --repo <repo-id> for pull request commands.`,
      {
        details: {
          taskId: task.id,
          repoIds: (task.repoTargets ?? []).map((target) => target.repoId),
        },
      },
    );
  }
  const projectTarget = task.repoTargets?.find((candidate) => candidate.repoId === repoId);
  if (!projectTarget) {
    throw targetConflict(task, repoId);
  }
  return {
    repoId,
    branch: projectTarget.branch,
    worktreePath: projectTarget.worktreePath,
    repository: await resolvePersistedOrLocalRepository(
      projectTarget.pullRequest,
      projectTarget.worktreePath,
      repoId,
      deps,
    ),
    projectTarget,
  };
}

async function resolvePersistedOrLocalRepository(
  pullRequest: Pick<TaskPR, "owner" | "repo" | "url"> | Pick<TaskPullRequest, "owner" | "repo" | "url"> | null,
  worktreePath: string,
  repoId: string,
  deps: AssociationDependencies,
): Promise<GitHubRepositoryLocator> {
  const persisted = getPersistedRepository(pullRequest);
  if (persisted) {
    return persisted;
  }
  return await deps.getGitHubRepositoryLocator(worktreePath).catch(() => null)
    ?? { owner: "", name: repoId };
}

function getPersistedRepository(
  pullRequest: Pick<TaskPR, "owner" | "repo" | "url"> | Pick<TaskPullRequest, "owner" | "repo" | "url"> | null,
): GitHubRepositoryLocator | null {
  if (pullRequest?.owner && pullRequest.repo) {
    return { owner: pullRequest.owner, name: pullRequest.repo };
  }
  return pullRequest?.url ? parseGitHubPullRequestUrl(pullRequest.url) : null;
}

async function buildTarget(
  repoId: string,
  branch: string,
  worktreePath: string,
  projectTarget: ProjectTaskRepoTarget | null,
  deps: AssociationDependencies,
): Promise<AssociationTarget> {
  const repository = await deps.getGitHubRepositoryLocator(worktreePath);
  if (!repository) {
    throw new CraigError(
      "EXTERNAL_DEPENDENCY_FAILED",
      `Repo ${repoId} does not have a supported GitHub origin remote.`,
      { details: { repoId, worktreePath } },
    );
  }
  return { repoId, branch, worktreePath, repository, projectTarget };
}

async function authenticate(target: AssociationTarget, deps: AssociationDependencies): Promise<void> {
  await callGitHub("verify GitHub CLI authentication", () => deps.ensureGhAuthenticated(target.worktreePath));
}

async function callGitHub<T>(operation: string, callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof CraigError) {
      throw error;
    }
    throw new CraigError(
      "EXTERNAL_DEPENDENCY_FAILED",
      `Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error },
    );
  }
}

function assertSelectorMatchesTarget(
  selector: GitHubRepositoryLocator | null,
  target: AssociationTarget,
): void {
  if (selector && !sameRepository(selector, target.repository)) {
    throw repositoryMismatch(selector, target);
  }
}

function assertPullRequestMatchesSelector(
  view: GhPrView,
  selector: ParsedPullRequestSelector,
): void {
  const viewLocator = parseGitHubPullRequestUrl(view.url);
  if (!viewLocator || viewLocator.number !== selector.number) {
    throw new CraigError(
      "TASK_CONTEXT_CONFLICT",
      `GitHub returned ${view.url} for pull request selector #${selector.number}.`,
      { details: { selectorNumber: selector.number, returnedUrl: view.url } },
    );
  }
  if (selector.repository && !sameRepository(selector.repository, viewLocator)) {
    throw new CraigError(
      "PR_REPOSITORY_MISMATCH",
      `GitHub returned a pull request from ${viewLocator.owner}/${viewLocator.name}, not ${selector.repository.owner}/${selector.repository.name}.`,
      { details: { selectorRepository: selector.repository, returnedRepository: viewLocator } },
    );
  }
}

function assertPullRequestMatchesTarget(view: GhPrView, target: AssociationTarget): void {
  const viewLocator = parseGitHubPullRequestUrl(view.url);
  if (!viewLocator || !sameRepository(viewLocator, target.repository)) {
    throw repositoryMismatch(viewLocator, target);
  }
  if (view.headRefName !== target.branch) {
    throw new CraigError(
      "PR_BRANCH_MISMATCH",
      `Pull request #${view.number} uses head branch ${view.headRefName}, not task branch ${target.branch}.`,
      {
        details: {
          repoId: target.repoId,
          pullRequestNumber: view.number,
          expectedBranch: target.branch,
          actualBranch: view.headRefName,
        },
      },
    );
  }
}

function repositoryMismatch(
  actual: GitHubRepositoryLocator | null,
  target: AssociationTarget,
): CraigError {
  return new CraigError(
    "PR_REPOSITORY_MISMATCH",
    `Pull request repository ${actual ? `${actual.owner}/${actual.name}` : "is invalid"} does not match task repo ${target.repository.owner}/${target.repository.name}.`,
    {
      details: {
        repoId: target.repoId,
        expectedOwner: target.repository.owner,
        expectedRepo: target.repository.name,
        actualOwner: actual?.owner ?? null,
        actualRepo: actual?.name ?? null,
      },
    },
  );
}

function targetConflict(task: TaskRecord, repoId: string): CraigError {
  return new CraigError(
    "TASK_CONTEXT_CONFLICT",
    `Repo ${repoId} is not a target of task ${task.id}.`,
    { details: { taskId: task.id, repoId } },
  );
}

function sameRepository(
  left: GitHubRepositoryLocator,
  right: GitHubRepositoryLocator,
): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase();
}

async function persistAssociation(
  paths: CraigPaths,
  task: TaskRecord,
  target: AssociationTarget,
  view: GhPrView,
  deps: AssociationDependencies,
): Promise<TaskRecord> {
  const existing = findPullRequest(task, target, view.number);
  const normalized = normalizePr(view, existing, target.repository);
  let nextTask = upsertTaskPr(task, normalized);
  if (target.projectTarget) {
    nextTask = {
      ...nextTask,
      repoTargets: (nextTask.repoTargets ?? []).map((candidate) =>
        candidate.repoId === target.repoId
          ? { ...candidate, pullRequest: toProjectPullRequest(normalized) }
          : candidate
      ),
    };
  }
  return persistTaskAndArtifact(paths, nextTask, deps);
}

function removeAssociation(
  task: TaskRecord,
  target: AssociationTarget,
  number: number,
): TaskRecord {
  const prs = task.prs.filter((pr) => !matchesTargetPullRequest(pr, target, number));
  let nextTask: TaskRecord = { ...task, prs };
  if (
    target.projectTarget?.pullRequest.number === number
  ) {
    const remaining = selectPrimaryPullRequest(prs.filter((pr) =>
      pr.owner && pr.repo && sameRepository(
        { owner: pr.owner, name: pr.repo },
        target.repository,
      )
    ));
    nextTask = {
      ...nextTask,
      repoTargets: (nextTask.repoTargets ?? []).map((candidate) =>
        candidate.repoId === target.repoId
          ? {
              ...candidate,
              pullRequest: remaining
                ? toProjectPullRequest(remaining)
                : emptyProjectPullRequest(target.repository),
            }
          : candidate
      ),
    };
  }
  return nextTask;
}

async function persistTaskAndArtifact(
  paths: CraigPaths,
  task: TaskRecord,
  deps: AssociationDependencies,
): Promise<TaskRecord> {
  const status = task.status === "closed"
      ? task.status
      : task.type === "project"
      ? deriveProjectTaskStatus(task)
      : deriveTaskStatusFromPrs(task.prs);
  const persisted = { ...task, status };
  return persistTaskAndPrStatus(paths, persisted, deps);
}

function findPullRequest(
  task: TaskRecord,
  target: AssociationTarget,
  number: number,
): TaskPR | null {
  return getTargetPullRequests(task, target).find((pr) =>
    matchesTargetPullRequest(pr, target, number)
  ) ?? null;
}

function getPrimaryPullRequest(
  task: TaskRecord,
  target: AssociationTarget,
): TaskPR | null {
  if (!target.projectTarget) {
    return getTaskPrimaryPr(task);
  }
  const pullRequests = getTargetPullRequests(task, target);
  return selectPrimaryPullRequest(pullRequests);
}

function selectPrimaryPullRequest(pullRequests: TaskPR[]): TaskPR | null {
  return [...pullRequests].reverse().find((pr) => pr.status !== "merged" && pr.status !== "closed")
    ?? pullRequests[pullRequests.length - 1]
    ?? null;
}

function getTargetPullRequests(task: TaskRecord, target: AssociationTarget): TaskPR[] {
  if (!target.projectTarget) {
    return task.prs;
  }
  const matching = task.prs.filter((pr) =>
    pr.owner && pr.repo && sameRepository(
      { owner: pr.owner, name: pr.repo },
      target.repository,
    )
  );
  const currentTarget = task.repoTargets?.find((candidate) => candidate.repoId === target.repoId);
  const mirrored = currentTarget?.pullRequest.number
    ? fromProjectPullRequest(currentTarget.pullRequest, target.repository)
    : null;
  if (mirrored && !matching.some((pr) => isSamePullRequest(pr, mirrored))) {
    return [...matching, mirrored];
  }
  return matching;
}

function matchesTargetPullRequest(
  pr: Pick<TaskPR, "owner" | "repo" | "number">,
  target: AssociationTarget,
  number: number,
): boolean {
  if (pr.number !== number) {
    return false;
  }
  return !pr.owner || !pr.repo || sameRepository(
    { owner: pr.owner, name: pr.repo },
    target.repository,
  );
}

function buildResult(
  task: TaskRecord,
  target: AssociationTarget,
  kind: CommandTaskPrResult["kind"],
  disposition: CommandTaskPrResult["disposition"],
  warnings: string[],
): CommandTaskPrResult {
  const pullRequests = getTargetPullRequests(task, target);
  return {
    kind,
    taskId: task.id,
    repoId: target.repoId,
    disposition,
    pullRequests,
    primaryPullRequest: getPrimaryPullRequest(task, target),
    warnings,
  };
}

function toProjectPullRequest(pr: TaskPR): TaskPullRequest {
  return {
    provider: "github",
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    status: pr.status === "draft" ? "open" : pr.status,
    draft: pr.draft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ?? null,
    requiredChecks: pr.requiredChecks,
    comments: pr.comments ?? [],
    lastSyncedAt: pr.lastSyncedAt,
    lastSyncedHeadSha: pr.lastSyncedHeadSha,
  };
}

function fromProjectPullRequest(
  pr: TaskPullRequest,
  repository: GitHubRepositoryLocator,
): TaskPR {
  return {
    provider: "github",
    owner: pr.owner ?? repository.owner,
    repo: pr.repo ?? repository.name,
    number: pr.number,
    url: pr.url,
    title: null,
    status: pr.draft ? "draft" : pr.status,
    draft: pr.draft ?? false,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ?? null,
    requiredChecks: pr.requiredChecks,
    comments: pr.comments ?? [],
    createdAt: null,
    updatedAt: null,
    mergedAt: null,
    lastSyncedAt: pr.lastSyncedAt,
    lastSyncedHeadSha: pr.lastSyncedHeadSha,
  };
}

function emptyProjectPullRequest(repository: GitHubRepositoryLocator): TaskPullRequest {
  return {
    provider: "github",
    owner: repository.owner,
    repo: repository.name,
    number: null,
    url: null,
    baseBranch: null,
    headBranch: null,
    status: null,
    draft: false,
    mergeable: false,
    mergeStateStatus: null,
    reviewDecision: null,
    requiredChecks: [],
    comments: [],
    lastSyncedAt: null,
    lastSyncedHeadSha: null,
  };
}

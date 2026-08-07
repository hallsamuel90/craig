import { runCommand, runCommandAllowingFailure } from "../../../shared/exec.js";
import type { TaskRecord } from "../types.js";
import { GitHubRateLimitError } from "../prs/errors.js";

export interface GhPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state: string;
  isDraft?: boolean;
  mergeable: string;
  mergeStateStatus: string | null;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  reviewDecision?: string | null;
  statusCheckRollup: unknown[];
  comments?: unknown[] | { nodes?: unknown[] | null } | null;
}

export interface GitHubRepositoryLocator {
  owner: string;
  name: string;
}

export interface GitHubPullRequestLocator extends GitHubRepositoryLocator {
  number: number;
}

export interface GhPrBatchRequest {
  id: string;
  selector: string;
  mode: "number" | "head";
}

export interface GhPrBatchResult {
  id: string;
  found: boolean;
  view: GhPrView | null;
}

export const ensureGhAuthenticated = async (worktreePath: string): Promise<void> => {
  const result = await runCommandAllowingFailure("gh", ["auth", "status"], { cwd: worktreePath });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "GitHub CLI auth is required.");
  }
};

export const createGitHubPullRequest = async (
  task: TaskRecord,
  bodyFile: string,
): Promise<void> => {
  await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      task.branch,
      "--title",
      task.lastCommit?.message ?? task.title,
      "--body-file",
      bodyFile,
    ],
    { cwd: task.worktreePath },
  );
};

export const mergeGitHubPr = async (
  worktreePath: string,
  prNumber: number,
  mergeMethod: "merge" | "rebase" | "squash",
): Promise<void> => {
  const flag = mergeMethod === "merge" ? "--merge" : mergeMethod === "rebase" ? "--rebase" : "--squash";

  await runCommand(
    "gh",
    ["pr", "merge", String(prNumber), flag, "--delete-branch=false"],
    { cwd: worktreePath },
  );
};

export const fetchPrView = async (selector: string, worktreePath: string): Promise<GhPrView> => {
  const result = await runCommand("gh", buildPrViewArgs(selector), { cwd: worktreePath });
  return JSON.parse(result.stdout) as GhPrView;
};

export const discoverPrView = async (branch: string, worktreePath: string): Promise<GhPrView | null> => {
  const result = await runCommandAllowingFailure("gh", buildPrViewArgs(branch), { cwd: worktreePath });

  if (result.exitCode === 0) {
    return JSON.parse(result.stdout) as GhPrView;
  }

  const message = result.stderr.trim() || result.stdout.trim();
  if (isPullRequestNotFoundMessage(message)) {
    return null;
  }
  throw new Error(message || `GitHub CLI failed while discovering a pull request for ${branch}.`);
};

export const discoverPrViewForCommand = async (
  branch: string,
  worktreePath: string,
): Promise<GhPrView | null> => {
  const result = await runCommandAllowingFailure("gh", buildPrViewArgs(branch), { cwd: worktreePath });
  if (result.exitCode === 0) {
    return JSON.parse(result.stdout) as GhPrView;
  }

  const message = result.stderr.trim() || result.stdout.trim();
  if (isPullRequestNotFoundMessage(message)) {
    return null;
  }
  throw new Error(message || `GitHub CLI failed while discovering a pull request for ${branch}.`);
};

export const fetchPullRequestViewsBatch = async (
  worktreePath: string,
  repository: GitHubRepositoryLocator,
  requests: GhPrBatchRequest[],
): Promise<GhPrBatchResult[]> => {
  if (requests.length === 0) {
    return [];
  }

  const query = buildBatchPrQuery(requests);
  let result;
  try {
    result = await runCommand("gh", [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${repository.owner}`,
      "-F",
      `name=${repository.name}`,
    ]);
  } catch (error) {
    if (isGitHubRateLimitFailure(error)) {
      throw new GitHubRateLimitError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  const payload = JSON.parse(result.stdout) as GhPrBatchResponse;
  const repositoryPayload = payload.data?.repository ?? {};

  return requests.map((request, index) => {
    const entry = repositoryPayload[`item${index}`];
    const view = normalizeBatchEntry(entry);
    return {
      id: request.id,
      found: view !== null,
      view,
    };
  });
};

export const getGitHubRepositoryLocator = async (worktreePath: string): Promise<GitHubRepositoryLocator | null> => {
  const result = await runCommandAllowingFailure("git", ["remote", "get-url", "origin"], { cwd: worktreePath });

  if (result.exitCode !== 0) {
    return null;
  }

  return parseGitHubRemoteUrl(result.stdout.trim());
};

export const parseGitHubPullRequestUrl = (value: string): GitHubPullRequestLocator | null => {
  const match = value.trim().match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    owner: match[1],
    name: match[2],
    number: Number(match[3]),
  };
};

const isGitHubRateLimitFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("secondary rate limit") ||
    message.includes("abuse detection") ||
    message.includes("api rate limit exceeded") ||
    message.includes("you have exceeded")
  );
};

const isPullRequestNotFoundMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no pull requests found") ||
    normalized.includes("could not resolve to a pullrequest")
  );
};

const buildPrViewArgs = (selector: string): string[] => {
  return [
    "pr",
    "view",
    selector,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid,state,isDraft,title,createdAt,updatedAt,mergedAt,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,comments",
  ];
};

const parseGitHubRemoteUrl = (value: string): GitHubRepositoryLocator | null => {
  const normalized = value.replace(/\.git$/, "");
  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }

  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  const sshUrlMatch = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/);
  if (sshUrlMatch?.[1] && sshUrlMatch[2]) {
    return { owner: sshUrlMatch[1], name: sshUrlMatch[2] };
  }

  return null;
};

interface GhPrBatchResponse {
  data?: {
    repository?: Record<string, unknown>;
  };
}

interface GhPrBatchPullRequest {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state: string;
  isDraft?: boolean;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  mergeable: string;
  mergeStateStatus: string | null;
  reviewDecision?: string | null;
  statusCheckRollup?: {
    contexts?: {
      nodes?: unknown[];
    } | null;
  } | null;
  comments?: {
    nodes?: unknown[] | null;
  } | null;
}

const buildBatchPrQuery = (requests: GhPrBatchRequest[]): string => {
  const fields = requests.map((request, index) => {
    const alias = `item${index}`;
    if (request.mode === "number") {
      return `${alias}: pullRequest(number: ${Number(request.selector)}) { ...PrFields }`;
    }

    return `${alias}: pullRequests(headRefName: ${JSON.stringify(request.selector)}, states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...PrFields } }`;
  });

  return `
query CraigPullRequestBatch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields.join("\n    ")}
  }
}

fragment PrFields on PullRequest {
  number
  url
  baseRefName
  headRefName
  headRefOid
  state
  isDraft
  title
  createdAt
  updatedAt
  mergedAt
  mergeable
  mergeStateStatus
  reviewDecision
  statusCheckRollup {
    contexts(first: 100) {
      nodes {
        __typename
        ... on CheckRun {
          name
          status
          conclusion
          startedAt
          completedAt
        }
        ... on StatusContext {
          context
          state
          createdAt
        }
      }
    }
  }
  comments(last: 4) {
    nodes {
      author {
        login
      }
      bodyText
      body
      createdAt
      url
    }
  }
}
`;
};

const normalizeBatchEntry = (entry: unknown): GhPrView | null => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = "nodes" in entry
    ? ((entry as { nodes?: unknown[] }).nodes?.[0] ?? null)
    : entry;

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const pullRequest = candidate as GhPrBatchPullRequest;
  const statusCheckRollup = pullRequest.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid ?? null,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft ?? false,
    title: pullRequest.title ?? null,
    createdAt: pullRequest.createdAt ?? null,
    updatedAt: pullRequest.updatedAt ?? null,
    mergedAt: pullRequest.mergedAt ?? null,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    reviewDecision: pullRequest.reviewDecision ?? null,
    statusCheckRollup,
    comments: pullRequest.comments?.nodes ?? [],
  };
};

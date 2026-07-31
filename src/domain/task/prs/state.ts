import type { TaskPR, TaskPullRequestCheck, TaskPullRequestReviewDecision, TaskRecord } from "../types.js";

export const getTaskPrimaryPr = (task: TaskRecord): TaskPR | null => {
  if (task.prs.length === 0) return null;
  // Prefer the most recently added non-terminal PR for sequential workflows
  const active = [...task.prs].reverse().find(
    (pr) => pr.status !== "merged" && pr.status !== "closed",
  );
  return active ?? task.prs[task.prs.length - 1] ?? null;
};

export const isPrTerminal = (pr: TaskPR): boolean => {
  return pr.status === "merged" || pr.status === "closed";
};

export const upsertTaskPr = (task: TaskRecord, pr: TaskPR): TaskRecord => {
  const idx = task.prs.findIndex(
    (candidate) => isSamePullRequest(candidate, pr),
  );
  const prs = idx >= 0
    ? task.prs.map((p, i) => (i === idx ? pr : p))
    : [...task.prs, pr];
  return { ...task, prs };
};

export const isSamePullRequest = (
  left: Pick<TaskPR, "owner" | "repo" | "number">,
  right: Pick<TaskPR, "owner" | "repo" | "number">,
): boolean => {
  if (left.number === null || right.number === null || left.number !== right.number) {
    return false;
  }
  if (!left.owner || !left.repo || !right.owner || !right.repo) {
    return true;
  }
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
};

type PrState = {
  mergeable: boolean;
  mergeStateStatus: string | null;
  reviewDecision?: TaskPullRequestReviewDecision;
  requiredChecks: TaskPullRequestCheck[];
  status: string | null;
};

export const deriveTaskStatusFromPrs = (prs: TaskPR[]): TaskRecord["status"] => {
  if (prs.length === 0) return "checked";
  const primary = ([...prs].reverse().find((pr) => pr.status !== "merged" && pr.status !== "closed")
    ?? prs[prs.length - 1])!;

  if (isMergeReady(primary)) {
    return "merge_ready";
  }

  if (primary.status === "merged") {
    return "merged";
  }

  if (primary.status === "open") {
    return "pr_open";
  }

  return "checked";
};

export const isMergeReady = (pullRequest: PrState): boolean => {
  return (
    pullRequest.mergeable &&
    !isReviewBlocked(pullRequest) &&
    pullRequest.requiredChecks.length > 0 &&
    pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
  );
};

const isReviewBlocked = (pullRequest: Pick<PrState, "mergeStateStatus" | "reviewDecision">): boolean => {
  return (
    pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    pullRequest.mergeStateStatus === "REVIEW_REQUIRED"
  );
};

export const summarizeRequiredChecks = (pullRequest: { requiredChecks: TaskPullRequestCheck[] }): string => {
  if (pullRequest.requiredChecks.length === 0) {
    return "no required checks";
  }

  return pullRequest.requiredChecks
    .map((check) => `${check.name}:${check.status}`)
    .join(", ");
};

export const normalizePr = (
  view: NormalizablePrView,
  existing: TaskPR | null,
  repository?: { owner: string; name: string },
): TaskPR => {
  const isDraft = view.isDraft ?? false;
  const rawStatus = normalizePrStatus(view.state, isDraft);
  return {
    provider: "github",
    owner: repository?.owner ?? existing?.owner ?? null,
    repo: repository?.name ?? existing?.repo ?? null,
    number: view.number,
    url: view.url,
    title: view.title ?? existing?.title ?? null,
    status: rawStatus,
    draft: isDraft,
    baseBranch: view.baseRefName,
    headBranch: view.headRefName,
    mergeable: view.mergeable === "MERGEABLE",
    mergeStateStatus: view.mergeStateStatus,
    reviewDecision: normalizeReviewDecision(view.reviewDecision ?? null),
    requiredChecks: normalizeRequiredChecks(view.statusCheckRollup),
    comments: view.comments === undefined
      ? existing?.comments ?? []
      : normalizePullRequestComments(view.comments),
    createdAt: view.createdAt ?? existing?.createdAt ?? null,
    updatedAt: view.updatedAt ?? existing?.updatedAt ?? null,
    mergedAt: view.mergedAt ?? existing?.mergedAt ?? null,
    lastSyncedAt: new Date().toISOString(),
    lastSyncedHeadSha: view.headRefOid ?? null,
  };
};

export interface NormalizablePrView {
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

const normalizePrStatus = (state: string, isDraft: boolean): TaskPR["status"] => {
  if (isDraft) return "draft";
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null;
};

const normalizeReviewDecision = (value: string | null): TaskPullRequestReviewDecision => {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return null;
};

type NormalizedCheckWithSortKey = TaskPullRequestCheck & { sortTime: number | null };

export const normalizeRequiredChecks = (entries: unknown[]): TaskPullRequestCheck[] => {
  const checks = entries
    .map((entry) => normalizeRequiredCheckWithSortKey(entry))
    .filter((entry): entry is NormalizedCheckWithSortKey => entry !== null);
  const byName = new Map<string, NormalizedCheckWithSortKey>();
  for (const check of checks) {
    const existing = byName.get(check.name);
    if (!existing || shouldReplaceCheck(existing, check)) {
      byName.set(check.name, check);
    }
  }
  return [...byName.values()].map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  }));
};

const normalizeRequiredCheckWithSortKey = (entry: unknown): NormalizedCheckWithSortKey | null => {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const candidate = entry as {
    name?: string;
    context?: string;
    state?: string;
    status?: string;
    conclusion?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
    createdAt?: string | null;
  };

  const name = candidate.name ?? candidate.context;
  const rawState = candidate.state ?? candidate.status ?? candidate.conclusion;

  if (!name) {
    return null;
  }

  return {
    name,
    status: normalizeCheckState(rawState ?? null, candidate.conclusion ?? null),
    conclusion: candidate.conclusion ?? null,
    sortTime: getCheckSortTime(candidate),
  };
};

const shouldReplaceCheck = (existing: NormalizedCheckWithSortKey, candidate: NormalizedCheckWithSortKey): boolean => {
  if (existing.sortTime !== null || candidate.sortTime !== null) {
    return (candidate.sortTime ?? 0) >= (existing.sortTime ?? 0);
  }
  if (isCancelledCheck(existing) && !isCancelledCheck(candidate)) {
    return true;
  }
  if (!isCancelledCheck(existing) && isCancelledCheck(candidate)) {
    return false;
  }
  return checkFallbackRank(candidate.status) >= checkFallbackRank(existing.status);
};

const isCancelledCheck = (check: Pick<TaskPullRequestCheck, "conclusion">): boolean => {
  return check.conclusion?.toUpperCase() === "CANCELLED";
};

const checkFallbackRank = (status: TaskPullRequestCheck["status"]): number => {
  switch (status) {
    case "pending": return 5;
    case "failed": return 4;
    case "success": return 3;
    case "skipped": return 2;
    default: return 1;
  }
};

const getCheckSortTime = (candidate: { completedAt?: string | null; startedAt?: string | null; createdAt?: string | null }): number | null => {
  const isoString = candidate.completedAt ?? candidate.startedAt ?? candidate.createdAt ?? null;
  if (!isoString) return null;
  const timestamp = new Date(isoString).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const normalizePullRequestComments = (value: NormalizablePrView["comments"]) => {
  const entries = Array.isArray(value) ? value : (value as { nodes?: unknown[] | null } | null)?.nodes;
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map(normalizePullRequestComment)
    .filter((comment): comment is NonNullable<typeof comment> => comment !== null)
    .slice(-4);
};

const normalizePullRequestComment = (entry: unknown) => {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const candidate = entry as {
    author?: { login?: string | null } | string | null;
    body?: string | null;
    bodyText?: string | null;
    createdAt?: string | null;
    url?: string | null;
  };
  const body = normalizeCommentBody(candidate.bodyText ?? candidate.body ?? "");
  if (!body) {
    return null;
  }

  return {
    author: typeof candidate.author === "string" ? candidate.author : (candidate.author as { login?: string | null } | null)?.login ?? null,
    body,
    createdAt: candidate.createdAt ?? null,
    url: candidate.url ?? null,
  };
};

const normalizeCommentBody = (value: string): string => {
  return value.replace(/\s+/g, " ").trim();
};

const normalizeCheckState = (state: string | null, conclusion: string | null): TaskPullRequestCheck["status"] => {
  const normalizedState = state?.toUpperCase() ?? null;
  const normalizedConclusion = conclusion?.toUpperCase() ?? null;

  if (normalizedConclusion === "SKIPPED" || normalizedState === "SKIPPED") {
    return "skipped";
  }

  if (normalizedState === "SUCCESS" || normalizedConclusion === "SUCCESS" || normalizedConclusion === "NEUTRAL") {
    return "success";
  }

  if (
    normalizedState === "PENDING" ||
    normalizedState === "EXPECTED" ||
    normalizedState === "IN_PROGRESS" ||
    normalizedState === "QUEUED" ||
    normalizedState === "REQUESTED" ||
    normalizedState === "WAITING"
  ) {
    return "pending";
  }

  if (
    normalizedState === "FAILURE" ||
    normalizedState === "FAILED" ||
    normalizedState === "ERROR" ||
    normalizedState === "TIMED_OUT" ||
    normalizedState === "CANCELLED" ||
    normalizedState === "ACTION_REQUIRED" ||
    normalizedState === "STARTUP_FAILURE" ||
    normalizedConclusion === "FAILURE" ||
    normalizedConclusion === "FAILED" ||
    normalizedConclusion === "ERROR" ||
    normalizedConclusion === "TIMED_OUT" ||
    normalizedConclusion === "CANCELLED" ||
    normalizedConclusion === "ACTION_REQUIRED" ||
    normalizedConclusion === "STARTUP_FAILURE"
  ) {
    return "failed";
  }

  if (normalizedState === "COMPLETED" && normalizedConclusion === null) {
    return "unknown";
  }

  if (normalizedState === "COMPLETED" && normalizedConclusion !== null) {
    return normalizeCheckState(normalizedConclusion, normalizedConclusion);
  }

  if (normalizedState === null && normalizedConclusion === null) {
    return "unknown";
  }

  return "unknown";
};

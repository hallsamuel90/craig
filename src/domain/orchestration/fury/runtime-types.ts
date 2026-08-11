import type { CraigActor } from "../types.js";
import type { FuryLimits, FuryPlanStep } from "./types.js";

export interface FuryPlan {
  schemaVersion: 1;
  id: string;
  planHash: string;
  definitionHash: string;
  name: string;
  sourceFile: string;
  rootTaskId: string;
  inputs: Record<string, string | number | boolean>;
  limits: FuryLimits;
  order: string[];
  waves: string[][];
  steps: FuryPlanStep[];
  createdBy: CraigActor;
  createdAt: string;
}

export interface FuryApproval {
  schemaVersion: 1;
  planId: string;
  planHash: string;
  approvedBy: Extract<CraigActor, { type: "human" }>;
  approvedAt: string;
}

export type FuryRunState = "pending" | "running" | "waiting_for_review" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type FuryStepState = "pending" | "running" | "waiting_for_review" | "changes_requested" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type FuryReviewState = "waiting_for_review" | "changes_requested" | "approved" | "rejected" | "timed_out" | "cancelled";
export type FuryReviewAction = "approve" | "reject" | "request_changes" | "resubmit";

export interface FuryStepRun {
  id: string;
  kind: FuryPlanStep["kind"];
  needs: string[];
  state: FuryStepState;
  plan: FuryPlanStep;
  taskId: string | null;
  agentTabId: string | null;
  commandId: string | null;
  reviewId: string | null;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: CraigActor | null;
  deadlineAt: string | null;
}

export interface FuryRun {
  schemaVersion: 1;
  id: string;
  planId: string;
  planHash: string;
  definitionHash: string;
  name: string;
  sourceFile: string;
  rootTaskId: string;
  state: FuryRunState;
  inputs: Record<string, string | number | boolean>;
  limits: FuryLimits;
  order: string[];
  stepRuns: Record<string, FuryStepRun>;
  actor: CraigActor;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  deadlineAt: string;
  completedAt: string | null;
}

export interface HumanReviewDecision {
  sequence: number;
  round: number;
  action: FuryReviewAction;
  message: string | null;
  actor: CraigActor;
  feedbackCommandId: string | null;
  occurredAt: string;
}

export interface HumanReviewCheckpoint {
  schemaVersion: 1;
  id: string;
  runId: string;
  stepId: string;
  state: FuryReviewState;
  title: string;
  summary: string;
  feedbackTarget: { taskId: string; agentTabId: string | null } | null;
  round: number;
  requestedAt: string;
  deadlineAt: string;
  version: number;
  lastDecision: HumanReviewDecision | null;
  history: HumanReviewDecision[];
  updatedAt: string;
}

export interface CommandRunFuryResult { kind: "runFury"; run: FuryRun; created: boolean }
export interface CommandPlanFuryResult { kind: "planFury"; plan: FuryPlan }
export interface CommandApproveFuryResult { kind: "approveFury"; plan: FuryPlan; approval: FuryApproval; created: boolean }
export interface CommandShowFuryResult { kind: "showFury"; run: FuryRun }
export interface CommandCancelFuryResult { kind: "cancelFury"; run: FuryRun; changed: boolean }
export interface CommandResumeFuryResult { kind: "resumeFury"; run: FuryRun }
export interface CommandStepFuryResult { kind: "completeFuryStep" | "failFuryStep"; run: FuryRun; step: FuryStepRun }
export interface CommandListFuryReviewsResult { kind: "listFuryReviews"; reviews: HumanReviewCheckpoint[] }
export interface CommandShowFuryReviewResult { kind: "showFuryReview"; review: HumanReviewCheckpoint }
export interface CommandActFuryReviewResult { kind: "actFuryReview"; review: HumanReviewCheckpoint; run: FuryRun }
export interface CommandWatchFuryResult { kind: "watchFury"; eventCount: number; lastSequence: number; cancelled: boolean }

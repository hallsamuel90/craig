import type { RunnerType } from "../../config/index.js";

export type FuryInputType = "string" | "number" | "boolean";

export interface FuryLimits {
  maxConcurrency: number;
  maxTasks: number;
  timeoutMs: number;
}

export interface FuryInputDefinition {
  type: FuryInputType;
  required: boolean;
  defaultValue?: string | number | boolean;
}

export interface FuryAgentStep {
  kind: "agent";
  id: string;
  needs: string[];
  task?: string;
  createChild?: { repo: string };
  runner?: RunnerType;
  prompt: string;
  outputSchema?: Record<string, unknown>;
}

export interface FuryHumanReviewStep {
  kind: "human_review";
  id: string;
  needs: string[];
  title: string;
  summary: string;
  feedbackTask?: string;
  timeoutMs?: number;
}

export type FuryStep = FuryAgentStep | FuryHumanReviewStep;

export interface FuryDefinition {
  version: 1;
  name: string;
  limits: FuryLimits;
  inputs: Record<string, FuryInputDefinition>;
  steps: FuryStep[];
}

export interface FuryPlanStep {
  id: string;
  kind: FuryStep["kind"];
  needs: string[];
  wave: number;
  target: { type: "task"; task: string } | { type: "create_child"; repo: string } | null;
  runner: RunnerType | null;
  prompt: string | null;
  outputSchema: Record<string, unknown> | null;
  review: { title: string; summary: string; feedbackTask: string | null; timeoutMs: number } | null;
}

export interface CommandValidateFuryResult {
  kind: "validateFury";
  schemaVersion: 1;
  valid: true;
  file: string;
  definitionHash: string;
  name: string;
  inputNames: string[];
  stepCount: number;
  order: string[];
  limits: FuryLimits;
}

export interface FuryPlanSpec {
  schemaVersion: 1;
  file: string;
  definitionHash: string;
  name: string;
  inputs: Record<string, string | number | boolean>;
  limits: FuryLimits;
  order: string[];
  waves: string[][];
  steps: FuryPlanStep[];
}

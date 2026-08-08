import type { RunnerType } from "../../config/index.js";

export type SwarmInputType = "string" | "number" | "boolean";

export interface SwarmLimits {
  maxConcurrency: number;
  maxTasks: number;
  timeoutMs: number;
}

export interface SwarmInputDefinition {
  type: SwarmInputType;
  required: boolean;
  defaultValue?: string | number | boolean;
}

export interface SwarmAgentStep {
  kind: "agent";
  id: string;
  needs: string[];
  task?: string;
  createChild?: { repo: string };
  runner?: RunnerType;
  prompt: string;
  outputSchema?: Record<string, unknown>;
}

export interface SwarmHumanReviewStep {
  kind: "human_review";
  id: string;
  needs: string[];
  title: string;
  summary: string;
  feedbackTask?: string;
  timeoutMs?: number;
}

export type SwarmStep = SwarmAgentStep | SwarmHumanReviewStep;

export interface SwarmDefinition {
  version: 1;
  name: string;
  limits: SwarmLimits;
  inputs: Record<string, SwarmInputDefinition>;
  steps: SwarmStep[];
}

export interface SwarmPlanStep {
  id: string;
  kind: SwarmStep["kind"];
  needs: string[];
  wave: number;
  target: { type: "task"; task: string } | { type: "create_child"; repo: string } | null;
  runner: RunnerType | null;
  prompt: string | null;
  outputSchema: Record<string, unknown> | null;
  review: { title: string; summary: string; feedbackTask: string | null; timeoutMs: number } | null;
}

export interface CommandValidateSwarmResult {
  kind: "validateSwarm";
  schemaVersion: 1;
  valid: true;
  file: string;
  definitionHash: string;
  name: string;
  inputNames: string[];
  stepCount: number;
  order: string[];
  limits: SwarmLimits;
}

export interface CommandPlanSwarmResult {
  kind: "planSwarm";
  schemaVersion: 1;
  file: string;
  definitionHash: string;
  name: string;
  inputs: Record<string, string | number | boolean>;
  limits: SwarmLimits;
  order: string[];
  waves: string[][];
  steps: SwarmPlanStep[];
  mutations: [];
}

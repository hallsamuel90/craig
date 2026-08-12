import { createHash } from "node:crypto";

import { CraigError } from "../../error/index.js";
import { configService } from "../../config/index.js";
import type {
  FuryAgentStep,
  FuryDefinition,
  FuryHumanReviewStep,
  FuryInputDefinition,
  FuryInputType,
  FuryStep,
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const TEMPLATE_PATTERN = /\$\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_INPUTS = 32;
const MAX_STEPS = 128;
const MAX_CONCURRENCY = 16;
const MAX_TASKS = 32;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_FURY_PROMPT_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 16;

export interface ValidatedFury {
  definition: FuryDefinition;
  hash: string;
  order: string[];
  waves: string[][];
}

export function validateFuryDefinition(value: unknown, sourceName: string): ValidatedFury {
  const issues: string[] = [];
  const root = object(value, "$", issues);
  unknownFields(root, ["version", "name", "limits", "inputs", "steps"], "$", issues);
  if (root.version !== 1) issues.push("$.version must be 1.");
  const name = identifier(root.name, "$.name", issues);
  const limits = validateLimits(root.limits, issues);
  const inputs = validateInputs(root.inputs, issues);
  const steps = validateSteps(root.steps, issues);
  if (steps.length > MAX_STEPS) issues.push(`$.steps may contain at most ${MAX_STEPS} steps.`);
  if (steps.filter((step) => step.kind === "agent" && step.createChild).length > limits.maxTasks) {
    issues.push("$.steps creates more child tasks than limits.max_tasks allows.");
  }

  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.needs) {
      if (!stepIds.has(dependency)) issues.push(`$.steps.${step.id}.needs references missing step "${dependency}".`);
      if (dependency === step.id) issues.push(`$.steps.${step.id}.needs cannot reference itself.`);
    }
  }
  const topology = buildTopology(steps, issues);
  if (topology) validateTemplates(steps, inputs, topology.ancestors, issues);
  if (issues.length > 0) invalid(sourceName, issues);

  const definition: FuryDefinition = { version: 1, name, limits, inputs, steps };
  return {
    definition,
    hash: createHash("sha256").update(stableStringify(definition)).digest("hex"),
    order: topology!.order,
    waves: boundWaves(topology!.waves, limits.maxConcurrency),
  };
}

function boundWaves(waves: string[][], maxConcurrency: number): string[][] {
  return waves.flatMap((wave) => {
    const batches: string[][] = [];
    for (let index = 0; index < wave.length; index += maxConcurrency) batches.push(wave.slice(index, index + maxConcurrency));
    return batches;
  });
}

function validateLimits(value: unknown, issues: string[]): FuryDefinition["limits"] {
  const limits = object(value, "$.limits", issues);
  unknownFields(limits, ["max_concurrency", "max_tasks", "timeout"], "$.limits", issues);
  const maxConcurrency = integer(limits.max_concurrency, "$.limits.max_concurrency", 1, MAX_CONCURRENCY, issues);
  const maxTasks = integer(limits.max_tasks, "$.limits.max_tasks", 1, MAX_TASKS, issues);
  const timeoutMs = duration(limits.timeout, "$.limits.timeout", issues);
  if (maxConcurrency > maxTasks) issues.push("$.limits.max_concurrency cannot exceed max_tasks.");
  return { maxConcurrency, maxTasks, timeoutMs };
}

function validateInputs(value: unknown, issues: string[]): Record<string, FuryInputDefinition> {
  if (value === undefined) return {};
  const raw = object(value, "$.inputs", issues);
  const entries = Object.entries(raw);
  if (entries.length > MAX_INPUTS) issues.push(`$.inputs may contain at most ${MAX_INPUTS} inputs.`);
  const inputs: Record<string, FuryInputDefinition> = {};
  for (const [id, candidate] of entries) {
    if (!ID_PATTERN.test(id)) issues.push(`$.inputs key "${id}" must match ${ID_PATTERN}.`);
    const input = object(candidate, `$.inputs.${id}`, issues);
    unknownFields(input, ["type", "required", "default"], `$.inputs.${id}`, issues);
    const type = inputType(input.type, `$.inputs.${id}.type`, issues);
    const required = input.required === undefined ? false : boolean(input.required, `$.inputs.${id}.required`, issues);
    if (required && input.default !== undefined) issues.push(`$.inputs.${id} cannot be required and have a default.`);
    if (input.default !== undefined && !matchesInputType(input.default, type)) {
      issues.push(`$.inputs.${id}.default must be a ${type}.`);
    }
    inputs[id] = {
      type,
      required,
      ...(input.default !== undefined && matchesInputType(input.default, type) ? { defaultValue: input.default } : {}),
    };
  }
  return inputs;
}

function validateSteps(value: unknown, issues: string[]): FuryStep[] {
  const raw = object(value, "$.steps", issues);
  const entries = Object.entries(raw);
  if (entries.length === 0) issues.push("$.steps must contain at least one step.");
  return entries.map(([id, candidate]) => {
    if (!ID_PATTERN.test(id)) issues.push(`$.steps key "${id}" must match ${ID_PATTERN}.`);
    const step = object(candidate, `$.steps.${id}`, issues);
    const needs = stringArray(step.needs, `$.steps.${id}.needs`, issues);
    if (new Set(needs).size !== needs.length) issues.push(`$.steps.${id}.needs cannot contain duplicates.`);
    return step.human_review !== undefined
      ? validateHumanStep(id, step, needs, issues)
      : validateAgentStep(id, step, needs, issues);
  });
}

function validateAgentStep(id: string, step: Record<string, unknown>, needs: string[], issues: string[]): FuryAgentStep {
  unknownFields(step, ["needs", "task", "create_child", "agent", "prompt", "output"], `$.steps.${id}`, issues);
  const hasTask = step.task !== undefined;
  const hasChild = step.create_child !== undefined;
  if (hasTask === hasChild) issues.push(`$.steps.${id} must define exactly one of task or create_child.`);
  const task = hasTask ? nonEmptyString(step.task, `$.steps.${id}.task`, issues) : undefined;
  let createChild: FuryAgentStep["createChild"];
  if (hasChild) {
    const child = object(step.create_child, `$.steps.${id}.create_child`, issues);
    unknownFields(child, ["repo", "workspace"], `$.steps.${id}.create_child`, issues);
    if (child.repo !== undefined && child.workspace !== undefined) {
      issues.push(`$.steps.${id}.create_child accepts only one of repo or workspace.`);
    }
    createChild = {
      ...(child.repo !== undefined
        ? { repo: nonEmptyString(child.repo, `$.steps.${id}.create_child.repo`, issues) }
        : {}),
      ...(child.workspace !== undefined
        ? { workspace: nonEmptyString(child.workspace, `$.steps.${id}.create_child.workspace`, issues) }
        : {}),
    };
  }
  let runner: FuryAgentStep["runner"];
  if (step.agent !== undefined) {
    const agent = object(step.agent, `$.steps.${id}.agent`, issues);
    unknownFields(agent, ["runner"], `$.steps.${id}.agent`, issues);
    if (agent.runner !== undefined) {
      try { runner = configService.runners.parse(nonEmptyString(agent.runner, `$.steps.${id}.agent.runner`, issues)); }
      catch { issues.push(`$.steps.${id}.agent.runner is unsupported.`); }
    }
  }
  const prompt = nonEmptyString(step.prompt, `$.steps.${id}.prompt`, issues);
  if (Buffer.byteLength(prompt) > MAX_FURY_PROMPT_BYTES) {
    issues.push(`$.steps.${id}.prompt exceeds ${MAX_FURY_PROMPT_BYTES} bytes.`);
  }
  let outputSchema: Record<string, unknown> | undefined;
  if (step.output !== undefined) {
    const output = object(step.output, `$.steps.${id}.output`, issues);
    unknownFields(output, ["schema"], `$.steps.${id}.output`, issues);
    outputSchema = validateJsonSchema(output.schema, `$.steps.${id}.output.schema`, issues, 0);
  }
  return {
    kind: "agent", id, needs, prompt,
    ...(task !== undefined ? { task } : {}),
    ...(createChild ? { createChild } : {}),
    ...(runner ? { runner } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function validateHumanStep(id: string, step: Record<string, unknown>, needs: string[], issues: string[]): FuryHumanReviewStep {
  unknownFields(step, ["needs", "human_review"], `$.steps.${id}`, issues);
  const review = object(step.human_review, `$.steps.${id}.human_review`, issues);
  unknownFields(review, ["title", "summary", "feedback_target", "timeout"], `$.steps.${id}.human_review`, issues);
  let feedbackTask: string | undefined;
  if (review.feedback_target !== undefined) {
    const target = object(review.feedback_target, `$.steps.${id}.human_review.feedback_target`, issues);
    unknownFields(target, ["task"], `$.steps.${id}.human_review.feedback_target`, issues);
    feedbackTask = nonEmptyString(target.task, `$.steps.${id}.human_review.feedback_target.task`, issues);
  }
  return {
    kind: "human_review",
    id,
    needs,
    title: nonEmptyString(review.title, `$.steps.${id}.human_review.title`, issues),
    summary: nonEmptyString(review.summary, `$.steps.${id}.human_review.summary`, issues),
    ...(feedbackTask ? { feedbackTask } : {}),
    ...(review.timeout !== undefined ? { timeoutMs: duration(review.timeout, `$.steps.${id}.human_review.timeout`, issues) } : {}),
  };
}

function validateJsonSchema(value: unknown, location: string, issues: string[], depth: number): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(`${location} exceeds the maximum schema depth of ${MAX_SCHEMA_DEPTH}.`);
    return {};
  }
  const schema = object(value, location, issues);
  unknownFields(schema, ["type", "properties", "required", "items", "enum", "additionalProperties", "description"], location, issues);
  const allowedTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (typeof schema.type !== "string" || !allowedTypes.includes(schema.type)) issues.push(`${location}.type is unsupported.`);
  if (schema.required !== undefined) stringArray(schema.required, `${location}.required`, issues);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) issues.push(`${location}.enum must be a non-empty array.`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    issues.push(`${location}.additionalProperties must be a boolean.`);
  }
  if (schema.properties !== undefined) {
    const properties = object(schema.properties, `${location}.properties`, issues);
    for (const [name, child] of Object.entries(properties)) {
      validateJsonSchema(child, `${location}.properties.${name}`, issues, depth + 1);
    }
  }
  if (schema.items !== undefined) validateJsonSchema(schema.items, `${location}.items`, issues, depth + 1);
  return schema;
}

function buildTopology(steps: FuryStep[], issues: string[]): {
  order: string[]; waves: string[][]; ancestors: Map<string, Set<string>>;
} | null {
  const ids = new Set(steps.map((step) => step.id));
  if (steps.some((step) => step.needs.some((need) => !ids.has(need)))) return null;
  const index = new Map(steps.map((step, position) => [step.id, position]));
  const remaining = new Map(steps.map((step) => [step.id, step.needs.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps) for (const need of step.needs) dependents.set(need, [...(dependents.get(need) ?? []), step.id]);
  let ready = steps.filter((step) => step.needs.length === 0).map((step) => step.id);
  const order: string[] = [];
  const waves: string[][] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => index.get(left)! - index.get(right)!);
    const wave = ready;
    waves.push(wave);
    order.push(...wave);
    const next: string[] = [];
    for (const id of wave) {
      for (const dependent of dependents.get(id) ?? []) {
        const count = remaining.get(dependent)! - 1;
        remaining.set(dependent, count);
        if (count === 0) next.push(dependent);
      }
    }
    ready = next;
  }
  if (order.length !== steps.length) {
    issues.push("$.steps must form an acyclic graph.");
    return null;
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const values = new Set<string>();
    for (const need of byId.get(id)!.needs) {
      values.add(need);
      for (const ancestor of ancestors.get(need) ?? []) values.add(ancestor);
    }
    ancestors.set(id, values);
  }
  return { order, waves, ancestors };
}

function validateTemplates(
  steps: FuryStep[],
  inputs: Record<string, FuryInputDefinition>,
  ancestors: Map<string, Set<string>>,
  issues: string[],
): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    const values = step.kind === "agent"
      ? [step.task, step.createChild?.repo, step.prompt]
      : [step.title, step.summary, step.feedbackTask];
    for (const value of values) {
      if (value === undefined) continue;
      const matches = [...value.matchAll(TEMPLATE_PATTERN)];
      const remainder = value.replace(TEMPLATE_PATTERN, "");
      if (remainder.includes("${{") || remainder.includes("}}")) {
        issues.push(`$.steps.${step.id} contains a malformed template expression.`);
      }
      for (const match of matches) validateReference(match[1]!.trim(), step, inputs, ancestors, byId, issues);
    }
  }
}

function validateReference(
  reference: string,
  step: FuryStep,
  inputs: Record<string, FuryInputDefinition>,
  ancestors: Map<string, Set<string>>,
  byId: Map<string, FuryStep>,
  issues: string[],
): void {
  const input = /^inputs\.([a-z][a-z0-9_-]{0,63})$/.exec(reference);
  if (input) {
    if (!inputs[input[1]!]) issues.push(`$.steps.${step.id} references undeclared input "${input[1]}".`);
    return;
  }
  const output = /^steps\.([a-z][a-z0-9_-]{0,63})\.(task_id|output(?:\.[A-Za-z0-9_-]+)*)$/.exec(reference);
  if (!output) {
    issues.push(`$.steps.${step.id} contains unsupported reference "${reference}".`);
    return;
  }
  const target = output[1]!;
  if (!(ancestors.get(step.id)?.has(target) ?? false)) {
    issues.push(`$.steps.${step.id} references step "${target}" without depending on it.`);
    return;
  }
  const targetStep = byId.get(target);
  if (!targetStep || targetStep.kind !== "agent") {
    issues.push(`$.steps.${step.id} references an output from non-agent step "${target}".`);
  } else if (output[2]!.startsWith("output") && !targetStep.outputSchema) {
    issues.push(`$.steps.${step.id} references output from step "${target}" without a declared output schema.`);
  } else if (output[2]!.startsWith("output.") && targetStep.outputSchema) {
    validateOutputPath(step.id, target, output[2]!.slice("output.".length).split("."), targetStep.outputSchema, issues);
  }
}

function validateOutputPath(
  stepId: string,
  targetId: string,
  segments: string[],
  schema: Record<string, unknown>,
  issues: string[],
): void {
  let current = schema;
  for (const segment of segments) {
    if (current.type !== "object") {
      issues.push(`$.steps.${stepId} references output path "${segments.join(".")}" not declared by step "${targetId}".`);
      return;
    }
    if (!isObject(current.properties)) {
      if (current.additionalProperties === false) {
        issues.push(`$.steps.${stepId} references output path "${segments.join(".")}" not declared by step "${targetId}".`);
      }
      return;
    }
    if (!Object.hasOwn(current.properties, segment)) {
      issues.push(`$.steps.${stepId} references output path "${segments.join(".")}" not declared by step "${targetId}".`);
      return;
    }
    const child = current.properties[segment];
    if (!isObject(child)) return;
    current = child;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function object(value: unknown, location: string, issues: string[]): Record<string, unknown> {
  if (isObject(value)) return value;
  issues.push(`${location} must be an object.`);
  return {};
}

function unknownFields(value: Record<string, unknown>, allowed: string[], location: string, issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) issues.push(`${location}.${key} is not supported.`);
}

function identifier(value: unknown, location: string, issues: string[]): string {
  const text = nonEmptyString(value, location, issues);
  if (!ID_PATTERN.test(text)) issues.push(`${location} must match ${ID_PATTERN}.`);
  return text;
}

function nonEmptyString(value: unknown, location: string, issues: string[]): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  issues.push(`${location} must be a non-empty string.`);
  return "";
}

function stringArray(value: unknown, location: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    issues.push(`${location} must be an array of non-empty strings.`);
    return [];
  }
  return value;
}

function integer(value: unknown, location: string, minimum: number, maximum: number, issues: string[]): number {
  if (Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum) return Number(value);
  issues.push(`${location} must be an integer from ${minimum} through ${maximum}.`);
  return minimum;
}

function boolean(value: unknown, location: string, issues: string[]): boolean {
  if (typeof value === "boolean") return value;
  issues.push(`${location} must be a boolean.`);
  return false;
}

function inputType(value: unknown, location: string, issues: string[]): FuryInputType {
  if (value === "string" || value === "number" || value === "boolean") return value;
  issues.push(`${location} must be string, number, or boolean.`);
  return "string";
}

function matchesInputType(value: unknown, type: FuryInputType): value is string | number | boolean {
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}

function duration(value: unknown, location: string, issues: string[]): number {
  if (typeof value !== "string") {
    issues.push(`${location} must be a duration such as 30m, 2h, or 1d.`);
    return 1;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    issues.push(`${location} must be a duration such as 30m, 2h, or 1d.`);
    return 1;
  }
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const result = Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_TIMEOUT_MS) {
    issues.push(`${location} must be between 1ms and 7d.`);
    return 1;
  }
  return result;
}

function invalid(sourceName: string, issues: string[]): never {
  throw new CraigError("FURY_DEFINITION_INVALID", `Fury definition ${sourceName} is invalid: ${issues[0]}`, {
    details: { file: sourceName, issues: [...new Set(issues)] },
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

import { readFile, stat } from "node:fs/promises";

import { CraigError } from "../../error/index.js";
import { MAX_FURY_DEFINITION_BYTES, parseFuryYaml } from "./parser.js";
import type { CommandValidateFuryResult, FuryInputDefinition, FuryPlanSpec, FuryPlanStep } from "./types.js";
import { MAX_FURY_PROMPT_BYTES, validateFuryDefinition, type ValidatedFury } from "./validate.js";

const INPUT_TEMPLATE = /\$\{\{\s*inputs\.([a-z][a-z0-9_-]{0,63})\s*\}\}/g;

export async function validateFuryFile(file: string): Promise<CommandValidateFuryResult> {
  const validated = await load(file);
  return {
    kind: "validateFury",
    schemaVersion: 1,
    valid: true,
    file,
    definitionHash: validated.hash,
    name: validated.definition.name,
    inputNames: Object.keys(validated.definition.inputs),
    stepCount: validated.definition.steps.length,
    order: validated.order,
    limits: validated.definition.limits,
  };
}

export async function planFuryFile(file: string, rawInputs: Record<string, string>): Promise<FuryPlanSpec> {
  const validated = await load(file);
  const inputs = resolveInputs(validated.definition.inputs, rawInputs);
  const waveByStep = new Map(validated.waves.flatMap((wave, index) => wave.map((id) => [id, index] as const)));
  const stepById = new Map(validated.definition.steps.map((step) => [step.id, step]));
  const steps: FuryPlanStep[] = validated.order.map((id) => {
    const step = stepById.get(id)!;
    if (step.kind === "human_review") {
      return {
        id,
        kind: step.kind,
        needs: step.needs,
        wave: waveByStep.get(id)!,
        target: null,
        runner: null,
        prompt: null,
        outputSchema: null,
        review: {
          title: renderRequired(step.title, inputs, `$.steps.${id}.human_review.title`),
          summary: renderRequired(step.summary, inputs, `$.steps.${id}.human_review.summary`),
          feedbackTask: step.feedbackTask
            ? renderRequired(step.feedbackTask, inputs, `$.steps.${id}.human_review.feedback_target.task`)
            : null,
          timeoutMs: step.timeoutMs ?? validated.definition.limits.timeoutMs,
        },
      };
    }
    return {
      id,
      kind: step.kind,
      needs: step.needs,
      wave: waveByStep.get(id)!,
      target: step.task
        ? { type: "task", task: renderRequired(step.task, inputs, `$.steps.${id}.task`) }
        : {
            type: "create_child",
            repo: renderRequired(step.createChild!.repo, inputs, `$.steps.${id}.create_child.repo`),
          },
      runner: step.runner ?? null,
      prompt: renderPrompt(step.prompt, inputs, id),
      outputSchema: step.outputSchema ?? null,
      review: null,
    };
  });
  return {
    schemaVersion: 1,
    file,
    definitionHash: validated.hash,
    name: validated.definition.name,
    inputs,
    limits: validated.definition.limits,
    order: validated.order,
    waves: validated.waves,
    steps,
  };
}

async function load(file: string): Promise<ValidatedFury> {
  let source: string;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("Path is not a regular file.");
    if (metadata.size > MAX_FURY_DEFINITION_BYTES) {
      throw new Error(`Definition exceeds ${MAX_FURY_DEFINITION_BYTES} bytes.`);
    }
    source = await readFile(file, "utf8");
  } catch (error) {
    throw new CraigError("FURY_DEFINITION_INVALID", `Fury definition ${file} could not be read.`, {
      details: { file },
      cause: error,
    });
  }
  return validateFuryDefinition(parseFuryYaml(source, file), file);
}

function resolveInputs(
  definitions: Record<string, FuryInputDefinition>,
  raw: Record<string, string>,
): Record<string, string | number | boolean> {
  const issues: string[] = [];
  for (const name of Object.keys(raw)) if (!definitions[name]) issues.push(`Input "${name}" is not declared.`);
  const resolved: Record<string, string | number | boolean> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const value = raw[name];
    if (value !== undefined) resolved[name] = coerce(value, definition.type, name, issues);
    else if (definition.defaultValue !== undefined) resolved[name] = definition.defaultValue;
    else if (definition.required) issues.push(`Required input "${name}" was not provided.`);
  }
  if (issues.length > 0) {
    throw new CraigError("FURY_INPUT_INVALID", "Fury inputs are invalid.", { details: { issues } });
  }
  return resolved;
}

function coerce(value: string, type: FuryInputDefinition["type"], name: string, issues: string[]): string | number | boolean {
  if (type === "string") return value;
  if (type === "number") {
    if (value.trim().length === 0) {
      issues.push(`Input "${name}" must be a finite number.`);
      return 0;
    }
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    issues.push(`Input "${name}" must be a finite number.`);
    return 0;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  issues.push(`Input "${name}" must be true or false.`);
  return false;
}

function renderInputs(value: string, inputs: Record<string, string | number | boolean>): string {
  return value.replace(INPUT_TEMPLATE, (_match, name: string) => {
    if (!Object.hasOwn(inputs, name)) {
      throw new CraigError("FURY_INPUT_INVALID", `Input "${name}" is required by a template but has no value.`, {
        details: { input: name },
      });
    }
    return String(inputs[name]);
  });
}

function renderRequired(value: string, inputs: Record<string, string | number | boolean>, location: string): string {
  const rendered = renderInputs(value, inputs);
  if (rendered.trim().length === 0) {
    throw new CraigError("FURY_INPUT_INVALID", `Resolved ${location} must be a non-empty string.`, {
      details: { location },
    });
  }
  return rendered;
}

function renderPrompt(value: string, inputs: Record<string, string | number | boolean>, stepId: string): string {
  const location = `$.steps.${stepId}.prompt`;
  const rendered = renderRequired(value, inputs, location);
  if (Buffer.byteLength(rendered) > MAX_FURY_PROMPT_BYTES) {
    throw new CraigError("FURY_INPUT_INVALID", `Resolved ${location} exceeds ${MAX_FURY_PROMPT_BYTES} bytes.`, {
      details: { location, maxBytes: MAX_FURY_PROMPT_BYTES },
    });
  }
  return rendered;
}

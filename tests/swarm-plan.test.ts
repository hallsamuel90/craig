import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseSwarmYaml, planSwarmFile, validateSwarmDefinition, validateSwarmFile } from "../src/domain/orchestration/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const VALID = `
version: 1
name: review-and-fix
limits:
  max_concurrency: 3
  max_tasks: 8
  timeout: 2h
inputs:
  task_id:
    type: string
    required: true
  strict:
    type: boolean
    default: false
steps:
  inspect:
    task: "\${{ inputs.task_id }}"
    agent:
      runner: codex
    prompt: "Inspect with strict=\${{ inputs.strict }}."
    output:
      schema:
        type: object
        required: [issues]
  fix:
    needs: [inspect]
    create_child:
      repo: craig
    prompt: "Fix: \${{ steps.inspect.output.issues }}"
  verify:
    needs: [fix]
    task: "\${{ steps.fix.task_id }}"
    prompt: Verify the work.
  human_review:
    needs: [verify]
    human_review:
      title: Review implementation
      summary: "Review \${{ steps.fix.task_id }}."
      feedback_target:
        task: "\${{ steps.fix.task_id }}"
      timeout: 1h
  publish:
    needs: [human_review]
    task: "\${{ steps.fix.task_id }}"
    prompt: Continue after approval.
`;

describe("swarm definition validation and planning", () => {
  test("validates and deterministically plans a fixed DAG with a human checkpoint", async () => {
    const file = await fixture("valid.yaml", VALID);
    const validated = await validateSwarmFile(file);
    const first = await planSwarmFile(file, { task_id: "task_1", strict: "true" });
    const second = await planSwarmFile(file, { strict: "true", task_id: "task_1" });

    expect(validated).toMatchObject({
      kind: "validateSwarm",
      valid: true,
      name: "review-and-fix",
      stepCount: 5,
      order: ["inspect", "fix", "verify", "human_review", "publish"],
      limits: { maxConcurrency: 3, maxTasks: 8, timeoutMs: 7_200_000 },
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "planSwarm",
      inputs: { task_id: "task_1", strict: true },
      waves: [["inspect"], ["fix"], ["verify"], ["human_review"], ["publish"]],
      mutations: [],
      steps: [
        { id: "inspect", wave: 0, target: { type: "task", task: "task_1" }, prompt: "Inspect with strict=true." },
        { id: "fix", wave: 1, target: { type: "create_child", repo: "craig" } },
        { id: "verify", wave: 2, target: { type: "task", task: "${{ steps.fix.task_id }}" } },
        { id: "human_review", wave: 3, review: { feedbackTask: "${{ steps.fix.task_id }}", timeoutMs: 3_600_000 } },
        { id: "publish", wave: 4, target: { type: "task", task: "${{ steps.fix.task_id }}" } },
      ],
    });
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ["unknown field", VALID.replace("name: review-and-fix", "name: review-and-fix\nshell: echo unsafe"), "$.shell is not supported"],
    ["cycle", VALID.replace("needs: [inspect]", "needs: [publish]"), "acyclic"],
    ["missing dependency", VALID.replace("needs: [inspect]", "needs: [missing]"), "missing step"],
    ["unrelated output", VALID.replace("needs: [fix]\n    task", "needs: [inspect]\n    task"), "without depending"],
    ["hybrid review", VALID.replace("needs: [verify]\n    human_review", "needs: [verify]\n    task: task_1\n    human_review"), "task is not supported"],
    ["invalid feedback target", VALID.replace("steps.fix.task_id }}\"\n      timeout", "steps.human_review.task_id }}\"\n      timeout"), "without depending"],
    ["excessive limits", VALID.replace("max_concurrency: 3", "max_concurrency: 17"), "1 through 16"],
    ["undeclared output", VALID.replace("    output:\n      schema:\n        type: object\n        required: [issues]\n", ""), "without a declared output schema"],
  ])("rejects %s", (_name, yaml, message) => {
    expect(() => validateSwarmDefinition(parseSwarmYaml(yaml, "fixture.yaml"), "fixture.yaml")).toThrow(message);
  });

  test("rejects YAML syntax hazards and malformed templates", () => {
    expect(() => parseSwarmYaml("version: 1\nversion: 1\n", "duplicate.yaml")).toThrow("invalid");
    expect(() => parseSwarmYaml("value: &shared ok\ncopy: *shared\n", "alias.yaml")).toThrow("invalid");
    const malformed = VALID.replace("${{ inputs.task_id }}", "${{ inputs.task_id }");
    expect(() => validateSwarmDefinition(parseSwarmYaml(malformed, "template.yaml"), "template.yaml"))
      .toThrow("malformed template");
  });

  test("bounds definition size and output-schema nesting", () => {
    expect(() => parseSwarmYaml("x".repeat(1024 * 1024 + 1), "large.yaml")).toThrow("exceeds");
    const nested = parseSwarmYaml(VALID, "nested.yaml") as Record<string, Record<string, Record<string, unknown>>>;
    let schema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 18; index += 1) schema = { type: "array", items: schema };
    nested.steps!.inspect!.output = { schema };
    expect(() => validateSwarmDefinition(nested, "nested.yaml"))
      .toThrow("maximum schema depth");
  });

  test("rejects missing, unknown, duplicate-like, and incorrectly typed plan inputs", async () => {
    const file = await fixture("inputs.yaml", VALID);
    await expect(planSwarmFile(file, {})).rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });
    await expect(planSwarmFile(file, { task_id: "task_1", extra: "x" })).rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });
    await expect(planSwarmFile(file, { task_id: "task_1", strict: "yes" })).rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });
  });

  test("revalidates input-rendered targets and prompt bounds", async () => {
    const file = await fixture("rendered-inputs.yaml", VALID);
    await expect(planSwarmFile(file, { task_id: "" })).rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });

    const numeric = await fixture("numeric-input.yaml", VALID
      .replace("strict:\n    type: boolean", "strict:\n    type: number")
      .replace("default: false", "default: 1"));
    await expect(planSwarmFile(numeric, { task_id: "task_1", strict: "" }))
      .rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });

    const expandedPrompt = await fixture(
      "expanded-prompt.yaml",
      VALID.replace("Inspect with strict=${{ inputs.strict }}.", "Inspect ${{ inputs.task_id }}."),
    );
    await expect(planSwarmFile(expandedPrompt, { task_id: "x".repeat(33 * 1024) }))
      .rejects.toMatchObject({ code: "SWARM_INPUT_INVALID" });
  });

  test("checks referenced output paths when the schema declares properties", () => {
    const schema = VALID.replace(
      "type: object\n        required: [issues]",
      "type: object\n        properties:\n          issues:\n            type: object\n            properties:\n              summary: { type: string }\n        required: [issues]",
    );
    expect(() => validateSwarmDefinition(
      parseSwarmYaml(schema.replace("steps.inspect.output.issues", "steps.inspect.output.issues.summary"), "valid-path.yaml"),
      "valid-path.yaml",
    )).not.toThrow();
    expect(() => validateSwarmDefinition(
      parseSwarmYaml(schema.replace("steps.inspect.output.issues", "steps.inspect.output.findigns"), "invalid-path.yaml"),
      "invalid-path.yaml",
    )).toThrow("not declared");
    expect(() => validateSwarmDefinition(
      parseSwarmYaml(schema.replace("steps.inspect.output.issues", "steps.inspect.output.issues.summary.extra"), "deep-path.yaml"),
      "deep-path.yaml",
    )).toThrow("not declared");
  });

  test("bounds each deterministic execution wave by max_concurrency", async () => {
    const parallel = VALID
      .replace("max_concurrency: 3", "max_concurrency: 2")
      .replace("  fix:\n", "  audit:\n    task: task_2\n    prompt: Audit independently.\n  summarize:\n    task: task_3\n    prompt: Summarize independently.\n  fix:\n")
      .replace("needs: [inspect]\n    create_child", "needs: [inspect, audit, summarize]\n    create_child");
    const file = await fixture("parallel.yaml", parallel);
    const plan = await planSwarmFile(file, { task_id: "task_1" });
    expect(plan.waves).toEqual([
      ["inspect", "audit"],
      ["summarize"],
      ["fix"],
      ["verify"],
      ["human_review"],
      ["publish"],
    ]);
    expect(plan.steps.find((step) => step.id === "summarize")?.wave).toBe(1);
  });

  test("validation and planning do not mutate the containing workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "craig-swarm-no-mutation-"));
    roots.push(root);
    const state = path.join(root, ".craig");
    await mkdir(path.join(state, "tasks"), { recursive: true });
    await writeFile(path.join(state, "sentinel.json"), "{\"stable\":true}\n", "utf8");
    const file = path.join(root, "swarm.yaml");
    await writeFile(file, VALID, "utf8");
    const before = await snapshot(state);

    await validateSwarmFile(file);
    await planSwarmFile(file, { task_id: "task_1" });

    expect(await snapshot(state)).toEqual(before);
  });
});

async function fixture(name: string, contents: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "craig-swarm-"));
  roots.push(root);
  const file = path.join(root, name);
  await writeFile(file, contents, "utf8");
  return file;
}

async function snapshot(root: string): Promise<Array<{ path: string; contents: string | null; mode: number }>> {
  const entries: Array<{ path: string; contents: string | null; mode: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const metadata = await stat(target);
      if (metadata.isDirectory()) await walk(target);
      else entries.push({ path: path.relative(root, target), contents: await readFile(target, "utf8"), mode: metadata.mode });
    }
  };
  await walk(root);
  return entries;
}

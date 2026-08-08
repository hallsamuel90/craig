#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { spawn } from "node-pty";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = resolve(repoRoot, "packages/cli");

class PtyOutputBuffer {
  value = "";
  waiters = [];

  append(chunk) {
    this.value += chunk;
    this.value = this.value.slice(-20000);
    for (const waiter of [...this.waiters]) {
      waiter.check();
    }
  }

  waitFor(marker, timeoutMs) {
    if (this.value.includes(marker)) {
      return Promise.resolve();
    }

    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        check: () => {
          if (!this.value.includes(marker)) {
            return;
          }

          clearTimeout(timer);
          this.waiters = this.waiters.filter((item) => item !== waiter);
          resolveWait();
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        rejectWait(new Error(`Timed out waiting for ${marker}. Output:\n${this.value}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "craig-package-smoke-"));
const packDir = join(tempRoot, "pack");
const projectDir = join(tempRoot, "project");
const npmCacheDir = join(tempRoot, "npm-cache");

try {
  await mkdir(packDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: packageDir,
    env: { ...process.env, npm_config_cache: npmCacheDir },
    maxBuffer: 1024 * 1024 * 10,
  });
  const [packResult] = JSON.parse(stdout);
  const tarball = join(packDir, packResult.filename);

  await execFileAsync("git", ["init"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "craig@example.invalid"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Craig Smoke"], { cwd: projectDir });
  await writeFile(join(projectDir, "README.md"), "# smoke\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: projectDir });
  await execFileAsync("npm", ["init", "-y"], { cwd: projectDir, env: { ...process.env, npm_config_cache: npmCacheDir }, maxBuffer: 1024 * 1024 * 10 });
  await execFileAsync("npm", ["install", tarball], { cwd: projectDir, env: { ...process.env, npm_config_cache: npmCacheDir }, maxBuffer: 1024 * 1024 * 20 });

  const craigBin = join(projectDir, "node_modules", ".bin", "craig");
  await execFileAsync(craigBin, ["repo", "list"], { cwd: projectDir, maxBuffer: 1024 * 1024 * 10 });
  const jsonResult = await execFileAsync(craigBin, ["--json", "repo", "list"], {
    cwd: projectDir,
    maxBuffer: 1024 * 1024 * 10,
  });
  const jsonEnvelope = JSON.parse(jsonResult.stdout);
  if (
    jsonEnvelope.schemaVersion !== 1 ||
    jsonEnvelope.command !== "repo.list" ||
    jsonEnvelope.ok !== true ||
    jsonEnvelope.data?.kind !== "listRepos"
  ) {
    throw new Error(`Packed CLI returned an invalid JSON envelope: ${jsonResult.stdout}`);
  }
  await expectJsonFailure(
    craigBin,
    ["--json", "task", "show", "task_missing_for_package_smoke"],
    projectDir,
    {
      exitCode: 3,
      command: "task.show",
      errorCode: "TASK_NOT_FOUND",
    },
  );
  await execFileAsync(craigBin, ["repo", "add", "."], { cwd: projectDir, maxBuffer: 1024 * 1024 * 10 });
  await writeFile(
    join(projectDir, ".craig", "config.json"),
    `${JSON.stringify({ previews: { agentOrchestration: true } }, null, 2)}\n`,
    "utf8",
  );
  const swarmFile = join(projectDir, "swarm-smoke.yaml");
  await writeFile(swarmFile, [
    "version: 1",
    "name: package-smoke",
    "limits: { max_concurrency: 1, max_tasks: 1, timeout: 1h }",
    "inputs:",
    "  task_id: { type: string, required: true }",
    "steps:",
    "  inspect:",
    "    task: \"${{ inputs.task_id }}\"",
    "    agent: { runner: codex }",
    "    prompt: Inspect the task.",
    "",
  ].join("\n"), "utf8");
  const validateResult = await execFileAsync(craigBin, ["--json", "swarm", "validate", swarmFile], {
    cwd: projectDir,
    maxBuffer: 1024 * 1024 * 10,
  });
  expectJsonSuccess(validateResult.stdout, "swarm.validate", "validateSwarm");
  const planResult = await execFileAsync(
    craigBin,
    ["--json", "swarm", "plan", swarmFile, "--input", "task_id=task_smoke"],
    { cwd: projectDir, maxBuffer: 1024 * 1024 * 10 },
  );
  const planEnvelope = expectJsonSuccess(planResult.stdout, "swarm.plan", "planSwarm");
  if (planEnvelope.data?.steps?.[0]?.target?.task !== "task_smoke" || planEnvelope.data?.mutations?.length !== 0) {
    throw new Error(`Packed CLI returned an invalid swarm plan: ${planResult.stdout}`);
  }

  const codexStubDir = join(tempRoot, "bin");
  await mkdir(codexStubDir, { recursive: true });
  const codexStub = join(codexStubDir, "codex");
  await writeFile(codexStub, "#!/usr/bin/env node\nprocess.stdout.write('codex_smoke_stub_ready\\n'); setInterval(() => {}, 1000);\n", "utf8");
  await chmod(codexStub, 0o755);

  await waitForCraigBoot(craigBin, projectDir, codexStubDir);
  process.stdout.write(`Package smoke passed for ${packResult.filename}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function expectJsonSuccess(stdout, command, kind) {
  const envelope = JSON.parse(stdout);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.command !== command ||
    envelope.ok !== true ||
    envelope.data?.kind !== kind
  ) {
    throw new Error(`Packed CLI returned an invalid JSON envelope: ${stdout}`);
  }
  return envelope;
}

async function waitForCraigBoot(craigBin, cwd, stubDir) {
  const output = new PtyOutputBuffer();
  const child = spawn(craigBin, [], {
    cwd,
    cols: 120,
    rows: 36,
    env: {
      ...process.env,
      CI: "",
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      SHELL: process.env.SHELL ?? "/bin/zsh",
      TERM: "xterm-256color",
    },
  });

  child.onData((chunk) => output.append(chunk));

  try {
    await output.waitFor("> Start", 10000);
  } finally {
    child.kill();
  }
}

async function expectJsonFailure(craigBin, args, cwd, expected) {
  try {
    await execFileAsync(craigBin, args, { cwd, maxBuffer: 1024 * 1024 * 10 });
    throw new Error(`Packed CLI unexpectedly succeeded: ${args.join(" ")}`);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== expected.exitCode ||
      !("stdout" in error) ||
      error.stdout !== "" ||
      !("stderr" in error) ||
      typeof error.stderr !== "string"
    ) {
      throw error;
    }

    const envelope = JSON.parse(error.stderr);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.command !== expected.command ||
      envelope.ok !== false ||
      envelope.error?.code !== expected.errorCode
    ) {
      throw new Error(`Packed CLI returned an invalid JSON error envelope: ${error.stderr}`);
    }
  }
}

#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = resolve(repoRoot, "packages/cli");
const npmCacheDir = join(tmpdir(), "craig-npm-cache");
const expectedFiles = new Set(["package/dist/cli.js", "package/README.md", "package/package.json"]);

const deniedPathPatterns = [
  /^package\/src(?:\/|$)/,
  /^package\/tests?(?:\/|$)/,
  /^package\/docs?(?:\/|$)/,
  /^package\/AGENTS\.md$/,
  /^package\/\.codex(?:\/|$)/,
  /^package\/\.context(?:\/|$)/,
  /^package\/\.craig(?:\/|$)/,
  /^package\/\.github(?:\/|$)/,
  /^package\/\.git(?:\/|$)/,
  /^package\/(?:pnpm-lock|package-lock|yarn.lock)(?:\.yaml|\.json)?$/,
  /^package\/.*(?:\.map|\.d\.ts|\.log|\.env|\.local)$/,
  /^package\/.*(?:rfc|RFC)/,
];

const deniedContentPatterns = [
  { name: "sourceMappingURL", pattern: /sourceMappingURL/ },
  { name: "private workspace path", pattern: /\/Users\/samhall\/projects\/craig|\/Users\/samhall\/conductor\/workspaces\/craig/ },
  { name: "repo guidance marker", pattern: /AGENTS\.md|Repo Guidance|Plan Mode handoff|docs\/rfcs|\.codex(?:\/|$)|\.context(?:\/|$)/ },
];

const tempDir = await mkdtemp(join(tmpdir(), "craig-package-audit-"));

try {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", tempDir], {
    cwd: packageDir,
    env: { ...process.env, npm_config_cache: npmCacheDir },
    maxBuffer: 1024 * 1024 * 10,
  });
  const [packResult] = JSON.parse(stdout);
  const files = packResult.files.map((file) => file.path).sort();
  const normalizedFiles = files.map((file) => `package/${file}`);
  const failures = [];

  for (const file of normalizedFiles) {
    if (!expectedFiles.has(file)) {
      failures.push(`unexpected file: ${file}`);
    }

    for (const pattern of deniedPathPatterns) {
      if (pattern.test(file)) {
        failures.push(`denied path: ${file}`);
      }
    }
  }

  for (const expectedFile of expectedFiles) {
    if (!normalizedFiles.includes(expectedFile)) {
      failures.push(`missing expected file: ${expectedFile}`);
    }
  }

  if (packResult.name !== "craig-cli") {
    failures.push(`unexpected package name: ${packResult.name}`);
  }

  if (!packResult.filename.endsWith(".tgz")) {
    failures.push(`unexpected pack filename: ${packResult.filename}`);
  }

  const { stdout: tarList } = await execFileAsync("tar", ["-tzf", join(tempDir, packResult.filename)], {
    maxBuffer: 1024 * 1024 * 10,
  });
  const tarFiles = tarList.trim().split("\n").filter(Boolean).sort();

  for (const file of tarFiles) {
    if (!expectedFiles.has(file)) {
      failures.push(`unexpected tar entry: ${file}`);
    }
  }

  const { stdout: cliContent } = await execFileAsync("tar", ["-xOf", join(tempDir, packResult.filename), "package/dist/cli.js"], {
    maxBuffer: 1024 * 1024 * 50,
  });

  if (!cliContent.startsWith("#!/usr/bin/env node\n")) {
    failures.push("dist/cli.js is missing the node shebang");
  }

  for (const rule of deniedContentPatterns) {
    if (rule.pattern.test(cliContent)) {
      failures.push(`denied content in dist/cli.js: ${rule.name}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Package audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }

  process.stdout.write(`Package audit passed for ${packResult.filename}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

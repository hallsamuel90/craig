#!/usr/bin/env node

import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(repoRoot, "packages/cli/dist/cli.js");

await rm(dirname(outfile), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(repoRoot, "src/cli.ts")],
  outfile,
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  minify: true,
  sourcemap: false,
  external: ["node-pty", "terminal-kit"],
  logLevel: "info",
});

await chmod(outfile, 0o755);

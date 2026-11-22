/* global process, Buffer, __CRAIG_PAYLOAD_ID__ */
const path = require("node:path");
const { homedir } = require("node:os");
const { createRequire } = require("node:module");
const { gunzipSync } = require("node:zlib");
const { getAsset, isSea } = require("node:sea");
const { prepareCache, pruneCache, validatePayload, manifestOf } = require("./resources.cjs");

try {
  const payload = JSON.parse(gunzipSync(Buffer.from(getAsset("payload")), { maxOutputLength: 96 * 1024 * 1024 }));
  if (payload.identity !== __CRAIG_PAYLOAD_ID__) throw new Error("Embedded resource identity mismatch");
  validatePayload(payload);
  const base = path.join(homedir(), "Library/Caches/craig/runtime-v1");
  if (process.argv.length === 3 && process.argv[2] === "--binary-info") {
    process.stdout.write(`${JSON.stringify({ ...JSON.parse(getAsset("build", "utf8")), resources: manifestOf(payload.files),
      runtime: { node: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch, standalone: isSea() },
    })}\n`);
  } else if (process.argv.length === 3 && process.argv[2] === "__craig-binary-payload") {
    // Build-time audit transport. Raw bytes stay in the audit process, not logs.
    process.stdout.write(Buffer.from(getAsset("payload")));
  } else if (process.argv.length === 3 && process.argv[2] === "--binary-cache-prune") {
    // Acquire a current verified generation first. Its PID lease protects it,
    // while inactive duplicate/corrupt generations can be removed as well.
    prepareCache(base, payload);
    process.stdout.write(`${JSON.stringify(pruneCache(base))}\n`);
  } else {
    const cached = prepareCache(base, payload);
    // Keep PID leases until a later launch/prune observes the PID is gone.
    // Removing a lease in an early exit handler could race later exit handlers.
    const entrypoint = path.join(cached.directory, "cli.js");
    process.argv[1] = entrypoint;
    createRequire(entrypoint)(path.join(cached.directory, "launch.cjs"));
  }
} catch (error) {
  process.stderr.write(`Craig standalone startup failed: ${error.message}\n`);
  process.exitCode = 1;
}

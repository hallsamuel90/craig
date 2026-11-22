// Test-only second build: same package version, distinct benign payload bytes.
// No archive/release is produced and no package/source version is edited.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { auditPayload, digest, payloadIdentity } from "./artifact.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const source = path.resolve(process.argv[2]);
const directory = path.join(root, ".craig/binary-build/upgrade-fixture");
mkdirSync(directory, { recursive: true });
const payload = JSON.parse(gunzipSync(execFileSync(source, ["__craig-binary-payload"], { maxBuffer: 96 * 1024 * 1024 }), { maxOutputLength: 96 * 1024 * 1024 }));
const original = payload.identity;
const entry = payload.files.find((file) => file.path === "cli.js");
const bytes = Buffer.concat([Buffer.from(entry.data, "base64"), Buffer.from("\n// benign upgrade fixture: distinct cached payload\n")]);
entry.data = bytes.toString("base64");
entry.sha256 = digest(bytes);
payload.identity = payloadIdentity(payload.files);
auditPayload(payload);
assert.notEqual(payload.identity, original);
writeFileSync(path.join(directory, "payload.gz"), gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
const { runtime, resources, ...metadata } = JSON.parse(execFileSync(source, ["--binary-info"], { encoding: "utf8" }));
void runtime; void resources;
metadata.payloadIdentity = payload.identity;
metadata.fixture = "upgrade-test-only";
metadata.dirty = true;
writeFileSync(path.join(directory, "build.json"), JSON.stringify(metadata));
await build({ entryPoints: [path.join(root, "scripts/binary/bootstrap.cjs")], outfile: path.join(directory, "bootstrap.cjs"),
  platform: "node", format: "cjs", target: "node26", bundle: true, minify: true, sourcemap: false,
  define: { __CRAIG_PAYLOAD_ID__: JSON.stringify(payload.identity) },
});
writeFileSync(path.join(directory, "sea.json"), JSON.stringify({ main: "bootstrap.cjs", output: "craig",
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: "none",
  assets: { payload: "payload.gz", build: "build.json" },
}));
execFileSync(path.join(root, ".craig/binary-build/toolchain/bin/node"), ["--build-sea", "sea.json"], { cwd: directory, stdio: "pipe" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", path.join(directory, "craig")], { stdio: "pipe" });
console.log(path.join(directory, "craig"));

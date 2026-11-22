import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyGhostty } from "../prepare-ghostty.mjs";
import { auditDistribution, auditPayload, digest, payloadIdentity, manifestOf } from "./artifact.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const version = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"))).version;
const config = JSON.parse(readFileSync(new URL("./toolchain.json", import.meta.url)));
const archive = path.resolve(process.argv[2] ?? path.join(root, `dist/binary/craig-${version}-darwin-arm64.tar.gz`));
const bytes = readFileSync(archive);
const files = new Map(auditDistribution(bytes).map((file) => [file.path, file.bytes]));
const expected = `${digest(bytes)}  ${path.basename(archive)}\n`;
assert.equal(readFileSync(path.join(path.dirname(archive), "SHA256SUMS"), "utf8"), expected, "Archive checksum mismatch");
const metadata = JSON.parse(files.get("build.json"));
assert.equal(metadata.version, version);
assert.equal(metadata.nodeArchiveSha256, config.nodeArchiveSha256);
assert.equal(metadata.node, config.node);
assert.equal(metadata.nodeAbi, config.nodeAbi);
assert.equal(metadata.target, config.target);
assert.ok(["ad-hoc-development-only", "developer-id"].includes(metadata.signing), "Unknown signature qualification");
const manifest = JSON.parse(files.get("payload-manifest.json"));
assert.equal(payloadIdentity(manifest.files), manifest.identity);
assert.equal(manifest.identity, metadata.payloadIdentity);
const allowlist = JSON.parse(readFileSync(new URL("./payload-allowlist.json", import.meta.url)));
const expectedPaths = ["cli.js", "package.json", "launch.cjs", "THIRD_PARTY_NOTICES", "node_modules/node-pty/build/Release/pty.node",
  ...allowlist.flatMap((pkg) => pkg.files.map((file) => `${pkg.path}/${file}`)),
].sort();
assert.deepEqual(manifest.files.map((file) => file.path).sort(), expectedPaths, "Unexpected embedded payload inventory");
const temporary = mkdtempSync(path.join(tmpdir(), "craig-binary-audit-"));
try {
  const binary = path.join(temporary, "craig");
  writeFileSync(binary, files.get("craig"), { mode: 0o700 });
  chmodSync(binary, 0o700);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary]);
  if (metadata.signing === "developer-id") execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", binary]);
  const embedded = JSON.parse(execFileSync(binary, ["--binary-info"], { encoding: "utf8", timeout: 15000 }));
  assert.deepEqual(embedded.runtime, { node: config.node, abi: config.nodeAbi, platform: "darwin", arch: "arm64", standalone: true });
  assert.equal(embedded.payloadIdentity, manifest.identity);
  assert.deepEqual(embedded.resources, manifest.files);
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(embedded[key], value);
  const compressed = execFileSync(binary, ["__craig-binary-payload"], { timeout: 15000, maxBuffer: 96 * 1024 * 1024 });
  const payload = auditPayload(JSON.parse(gunzipSync(compressed, { maxOutputLength: 96 * 1024 * 1024 })));
  assert.deepEqual(manifestOf(payload.files), manifest.files);
  const resources = new Map(payload.files.map((file) => [file.path, Buffer.from(file.data, "base64")]));
  const wasm = resources.get("cli.js").toString("utf8").match(/["'](AGFzbQ[A-Za-z0-9+/]{100000,}={0,2})["']/);
  assert.ok(wasm, "Standalone payload does not embed Ghostty Wasm");
  assert.ok(WebAssembly.validate(verifyGhostty(Buffer.from(wasm[1], "base64"))), "Invalid embedded Ghostty module");
  assert.deepEqual(resources.get("THIRD_PARTY_NOTICES"), files.get("THIRD_PARTY_NOTICES"));
  assert.deepEqual(files.get("LICENSE"), readFileSync(path.join(root, "LICENSE")));
  const notices = files.get("THIRD_PARTY_NOTICES").toString("utf8");
  for (const notice of ["libghostty-vt 1.0.0", "Highway", "simdutf", "translate_c", "uucode", "Wuffs", "UNICODE LICENSE V3", "Bjoern Hoehrmann", "Zig contributors"]) {
    assert.ok(notices.includes(notice), `Missing bundled terminal notice: ${notice}`);
  }
  for (const pkg of [...allowlist, { name: "Node", version: config.node }, { name: "NAN", version: config.nan }, { name: "yaml", version: config.yaml }]) {
    assert.ok(notices.includes(`${pkg.name} ${pkg.version}\n`), `Missing licence attribution for ${pkg.name}`);
  }
  const addon = path.join(temporary, "pty.node");
  writeFileSync(addon, resources.get("node_modules/node-pty/build/Release/pty.node"), { mode: 0o600 });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", addon]);
  if (metadata.signing === "developer-id") execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", addon]);
  const linkage = execFileSync("/usr/bin/otool", ["-L", addon], { encoding: "utf8" }).trim().split("\n").slice(1).map((line) => line.trim().split(" ")[0]);
  assert.ok(linkage.length > 0 && linkage.every((lib) => lib.startsWith("/usr/lib/") || lib.startsWith("/System/Library/")));
  assert.deepEqual(linkage, metadata.linkage);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(`Standalone artifact audit passed: ${path.basename(archive)}`);

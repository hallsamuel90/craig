import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import resources from "./resources.cjs";

export const { digest, safePath, manifestOf, payloadIdentity, validatePayload } = resources;
const upstreamRuntimePathInventory = JSON.parse(readFileSync(new URL("./toolchain.json", import.meta.url))).upstreamRuntimePathInventorySha256;
const currentBuildRoot = Buffer.from(realpathSync(path.resolve(import.meta.dirname, "../..")));
export function auditResource(name, bytes) {
  safePath(name);
  if (/(^|\/)(?:AGENTS\.md|\.craig|\.git|\.github|\.codex|tests?|docs?|bench|typings)(\/|$)|\.(?:map|ts|log|env)$|(?:^|\/)(?:pnpm-lock|package-lock|tsconfig)/i.test(name)) {
    throw new Error(`Denied artifact path: ${name}`);
  }
  const content = bytes.toString("utf8");
  if (bytes.includes(currentBuildRoot)) throw new Error(`Private checkout path in ${name}`);
  const privatePaths = bytes.toString("latin1").match(/\/(?:Users|home)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.$()/+{}:@~-]+|\/(?:private\/)?var\/folders\/[A-Za-z0-9_./-]+/g) ?? [];
  // The verified upstream Node runtime itself contains public release-builder
  // diagnostic paths. Permit only the exact pinned inventory, only in the binary;
  // never exempt Craig's JS, native addon, manifest or additional build paths.
  if ((name !== "craig" && /sourceMappingURL/.test(content))
      || (privatePaths.length > 0 && (name !== "craig" || digest(JSON.stringify([...new Set(privatePaths)].sort())) !== upstreamRuntimePathInventory))) {
    throw new Error(`Denied source map or private path in ${name}`);
  }
}
export function makePayload(files) {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path, "en")).map((file) => {
    auditResource(file.path, file.bytes);
    return { path: file.path, mode: file.mode ?? 0o600, sha256: digest(file.bytes), data: file.bytes.toString("base64") };
  });
  return validatePayload({ format: 1, identity: payloadIdentity(entries), files: entries });
}
export function auditPayload(payload) {
  validatePayload(payload);
  for (const file of payload.files) auditResource(file.path, Buffer.from(file.data, "base64"));
  return payload;
}
function field(header, value, offset, length) { header.write(value, offset, length, "ascii"); }
export function archiveFiles(files) {
  const chunks = [];
  for (const { path: name, bytes, mode = 0o600 } of [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    safePath(name);
    if (Buffer.byteLength(name) > 99) throw new Error("Distribution filename too long");
    const header = Buffer.alloc(512);
    field(header, name, 0, 100);
    for (const [value, offset, length] of [[mode, 100, 8], [0, 108, 8], [0, 116, 8], [bytes.length, 124, 12], [0, 136, 12]]) {
      field(header, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    }
    header.fill(32, 148, 156);
    field(header, "0", 156, 1);
    field(header, "ustar\0", 257, 6);
    field(header, "00", 263, 2);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    field(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
}
export function readArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = [];
  const names = new Set();
  let ended = false;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (tar.length - offset < 1024 || tar.length % 512 !== 0 || !tar.subarray(offset).every((value) => value === 0)) throw new Error("Unexpected trailing archive data");
      ended = true;
      break;
    }
    const name = safePath(header.subarray(0, 100).toString("ascii").split("\0")[0]);
    const size = parseInt(header.subarray(124, 136).toString("ascii"), 8);
    const checksum = parseInt(header.subarray(148, 156).toString("ascii"), 8);
    const expected = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (names.has(name) || checksum !== expected || header[156] !== 48 || !Number.isSafeInteger(size)
        || !header.subarray(157, 257).every((value) => value === 0)
        || !header.subarray(265).every((value) => value === 0)
        || [108, 116, 136].some((start) => parseInt(header.subarray(start, start + (start === 136 ? 12 : 8)).toString("ascii"), 8) !== 0)
        || size < 0 || offset + 512 + size > tar.length) throw new Error("Invalid distribution archive");
    names.add(name);
    files.push({ path: name, mode: parseInt(header.subarray(100, 108).toString("ascii"), 8), bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error("Missing distribution archive terminator");
  return files;
}
export function auditDistribution(bytes) {
  const files = readArchive(bytes);
  const allowed = ["craig", "LICENSE", "THIRD_PARTY_NOTICES", "build.json", "payload-manifest.json"];
  if (files.length !== allowed.length || files.some((file) => !allowed.includes(file.path))) throw new Error("Unexpected distribution contents");
  if (files.some((file) => file.mode !== (file.path === "craig" ? 0o755 : 0o600))) throw new Error("Unexpected distribution file mode");
  for (const file of files) auditResource(file.path, file.bytes);
  return files;
}

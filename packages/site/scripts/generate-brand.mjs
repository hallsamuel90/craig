// Deterministic nearest-neighbour exports. No raster editor or native dependency.
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import process from "node:process";
import { URL } from "node:url";
import { brandBackground, brandGreen, rabbitRows, rabbitSize, rabbitSvg } from "../src/brand/rabbit.mjs";

const output = new URL("../public/", import.meta.url);
const check = process.argv.includes("--check");
const rgb = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function png(size, transparent = false) {
  const foreground = rgb(brandGreen), background = rgb(brandBackground);
  const pixels = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ink = rabbitRows[Math.floor(y * rabbitSize / size)][Math.floor(x * rabbitSize / size)] === "#";
      const offset = y * (1 + size * 4) + 1 + x * 4;
      pixels.set(ink ? foreground : background, offset);
      pixels[offset + 3] = ink || !transparent ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function rasterContents(bytes) {
  const imageData = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") imageData.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return Buffer.concat([bytes.subarray(0, 29), inflateSync(Buffer.concat(imageData))]);
}
const assets = new Map([
  ["favicon.svg", rabbitSvg({ background: true })],
  ["favicon.png", png(256)],
  ["brand/craig-icon.svg", rabbitSvg({ background: true })],
  ["brand/craig-mark.svg", rabbitSvg()],
  ["brand/craig-icon-32.png", png(32)],
  ["brand/craig-icon-512.png", png(512)],
  ["brand/craig-icon-1024.png", png(1024)],
  ["brand/craig-mark-512.png", png(512, true)],
]);
for (const [name, content] of assets) {
  const file = new URL(name, output), expected = Buffer.from(content);
  if (check) {
    const actual = await readFile(file).catch(() => null);
    // Compare raster pixels, not zlib output bytes: CI's Node/zlib version may
    // choose a different valid compression stream for the exact same image.
    const matches = actual && (name.endsWith(".png")
      ? rasterContents(actual).equals(rasterContents(expected)) : actual.equals(expected));
    if (!matches) throw new Error(`${name} is stale. Run pnpm --dir packages/site brand:generate.`);
  } else {
    await mkdir(new URL(".", file), { recursive: true });
    await writeFile(file, expected);
  }
}
process.stdout.write(`Craig pixel rabbit: ${assets.size} exports ${check ? "verified" : "generated"}.\n`);

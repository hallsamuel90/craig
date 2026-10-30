import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { inflateSync } from "node:zlib";
import { brandBackground, brandGreen, rabbitPath, rabbitRows, rabbitSize, rabbitSvg } from "../src/brand/rabbit.mjs";

test("the rabbit pixelates the original solid silhouette without added details", () => {
  assert.equal(rabbitRows.length, 32);
  const ink = [];
  rabbitRows.forEach((row, y) => {
    assert.equal(row.length, 32);
    [...row].forEach((pixel, x) => { if (pixel === "#") ink.push([x, y]); });
  });
  assert.ok(ink.length > 150);
  assert.ok(ink.every(([x, y]) => x >= 1 && y >= 1 && x < 31 && y < 31));
  const originalShapes = [
    [10, 5, 2, 6], [14, 4, 1.8, 5.5], [12, 14, 5, 5],
    [17, 22, 7.5, 7.5], [24, 18, 2.5, 2.5],
    [10, 29, 3.5, 1.5], [21, 29, 4, 1.5],
  ];
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      const ox = x + 0.5 - 1;
      const oy = y + 0.5 - 1;
      const solid = originalShapes.some(([cx, cy, rx, ry]) =>
        ((ox - cx) / rx) ** 2 + ((oy - cy) / ry) ** 2 <= 1);
      assert.equal(rabbitRows[y][x], solid ? "#" : " ", `${x},${y}`);
    }
  }
  assert.match(rabbitPath, /^[M\dhvHz ]+$/);
});

test("the public SVG icons use the canonical geometry, palette and crisp edges", async () => {
  const icon = await readFile(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.equal(icon, rabbitSvg({ background: true }));
  assert.equal(await readFile(new URL("../public/brand/craig-icon.svg", import.meta.url), "utf8"), icon);
  assert.equal(await readFile(new URL("../public/brand/craig-mark.svg", import.meta.url), "utf8"), rabbitSvg());
  assert.ok(icon.includes('shape-rendering="crispEdges"'));
  assert.ok(icon.includes(brandGreen) && icon.includes(brandBackground));
  assert.doesNotMatch(icon, /ellipse|circle|\brx=/);
});

test("PNG exports preserve hard-edged pixels and match the same rabbit at every size", async () => {
  for (const [file, size, transparent] of [
    ["favicon.png", 256, false], ["brand/craig-icon-32.png", 32, false],
    ["brand/craig-icon-512.png", 512, false], ["brand/craig-icon-1024.png", 1024, false],
    ["brand/craig-mark-512.png", 512, true],
  ]) {
    const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
    assert.equal(bytes.readUInt32BE(16), size, file);
    assert.equal(bytes.readUInt32BE(20), size, file);
    const idat = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    const raw = inflateSync(new Uint8Array(idat.flatMap((chunk) => [...chunk])));
    const hex = (value) => [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16));
    for (let y = 0; y < size; y++) {
      assert.equal(raw[y * (1 + size * 4)], 0, file);
      for (let x = 0; x < size; x++) {
        const ink = rabbitRows[Math.floor(y * rabbitSize / size)][Math.floor(x * rabbitSize / size)] === "#";
        const offset = y * (1 + size * 4) + 1 + x * 4;
        const expected = [...hex(ink ? brandGreen : brandBackground), ink || !transparent ? 255 : 0];
        // Check bytes directly; anti-aliased intermediate colours must never appear.
        for (let channel = 0; channel < 4; channel++) {
          if (raw[offset + channel] !== expected[channel]) assert.fail(`${file}: unexpected pixel at ${x},${y}`);
        }
      }
    }
  }
});

test("every built page uses the new favicon and the shared pixel rabbit", async () => {
  for (const route of ["index.html", "docs/index.html", "blog/index.html", "blog/fury-explicit-completion/index.html"]) {
    const html = await readFile(new URL(`../dist/${route}`, import.meta.url), "utf8");
    assert.ok(html.includes('/favicon.svg?v=pixel-1'), route);
    assert.ok(html.includes('/favicon.png?v=pixel-1'), route);
    assert.ok(html.includes(rabbitPath), route);
  }
});

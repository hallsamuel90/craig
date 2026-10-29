import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const pages = await Promise.all((await readdir(dist, { recursive: true }))
  .filter((file) => file.endsWith("index.html"))
  .map(async (file) => ({ file, html: await readFile(new URL(file, dist), "utf8") })));
const headerOf = ({ file, html }) => {
  const headers = html.match(/<header\b[^>]*class="[^"]*\bsite-header\b[^"]*"[^>]*>[\s\S]*?<\/header>/g) ?? [];
  assert.equal(headers.length, 1, `${file}: exactly one shared header`);
  return headers[0];
};

test("every built route renders the same global header, apart from active-section metadata", () => {
  assert.ok(pages.length >= 12, "expected the homepage, blog, and documentation routes");
  const normalize = (header) => header.replace(/\s+aria-current="(?:page|location)"/g, "").replace(/\s+/g, " ");
  const baseline = normalize(headerOf(pages.find(({ file }) => file === "index.html")));
  for (const page of pages) {
    const header = headerOf(page);
    assert.equal(normalize(header), baseline, page.file);
    assert.equal((page.html.match(/aria-label="Main navigation"/g) ?? []).length, 1, page.file);
    assert.deepEqual([...header.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]), [
      "/", "/docs/quickstart/", "/docs/", "/blog/", "https://github.com/hallsamuel90/craig", "/docs/install/",
    ], page.file);
  }
});

test("Docs and Blog keep their active section on both indexes and nested routes", () => {
  for (const page of pages) {
    const active = [...headerOf(page).matchAll(/<a\b[^>]*>/g)]
      .filter(([tag]) => tag.includes("aria-current="))
      .map(([tag]) => ({
        href: tag.match(/href="([^"]+)"/)[1],
        current: tag.match(/aria-current="([^"]+)"/)[1],
      }));
    const section = page.file.startsWith("docs/") ? "docs"
      : page.file.startsWith("blog/") ? "blog" : null;
    assert.deepEqual(active, section ? [{
      href: `/${section}/`, current: page.file === `${section}/index.html` ? "page" : "location",
    }] : [], page.file);
  }
});

test("only documentation pages include the separately labelled documentation navigation", () => {
  for (const page of pages) {
    assert.equal(page.html.includes('aria-label="Documentation navigation"'), page.file.startsWith("docs/"), page.file);
  }
});

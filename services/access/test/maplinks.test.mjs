// Map's second source (src/maplinks.mjs): the start page's links, filtered as the core filters its own and merged
// after the core's sitemap links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStartUrl, mergeMapLinks } from "../src/maplinks.mjs";

test("a start URL naming a file maps its directory; a directory or bare path is kept", () => {
  assert.equal(mapStartUrl("https://books.toscrape.com/index.html"), "https://books.toscrape.com/");
  assert.equal(mapStartUrl("https://b.example/catalogue/category/books/poetry_23/index.html?x=1#y"), "https://b.example/catalogue/category/books/poetry_23/");
  assert.equal(mapStartUrl("https://docs.example/uv/"), "https://docs.example/uv/");
  assert.equal(mapStartUrl("https://docs.example/docs"), "https://docs.example/docs");
});

test("a site without a sitemap gets its start page's same-site links, once each, without fragments or queries", () => {
  const page = ["https://books.toscrape.com/index.html", "https://books.toscrape.com/catalogue/a_1/index.html", "https://books.toscrape.com/catalogue/a_1/index.html#top",
    "https://books.toscrape.com/catalogue/page-2.html?sort=1", "https://www.books.toscrape.com/catalogue/page-2.html", "https://elsewhere.example/", "mailto:a@b.example",
    "javascript:void(0)", "not a url", "https://cdn.books.toscrape.com/x.css"];
  const { links, added } = mergeMapLinks({ url: "https://books.toscrape.com/index.html" }, [], page);
  assert.deepEqual(links.map((l) => l.url), ["https://books.toscrape.com/index.html", "https://books.toscrape.com/catalogue/a_1/index.html",
    "https://books.toscrape.com/catalogue/page-2.html", "https://cdn.books.toscrape.com/x.css"]);
  assert.equal(added, 4);
  // Subdomains only when asked (the core's default includes them); queries kept when asked.
  assert.equal(mergeMapLinks({ url: "https://books.toscrape.com/", includeSubdomains: false }, [], page).links.some((l) => l.url.includes("cdn.")), false);
  assert.ok(mergeMapLinks({ url: "https://books.toscrape.com/", ignoreQueryParameters: false }, [], page).links.some((l) => l.url.endsWith("?sort=1")));
});

test("the core's links come first and keep their order and fields; the page adds only what they lack, under the start path, within the limit", () => {
  const core = [{ url: "https://d.example/uv/a", title: "A" }, { url: "https://d.example/uv/b/" }];
  const page = ["https://d.example/uv/b", "https://d.example/uv/c", "https://d.example/other", "https://d.example/uv/d"];
  const r = mergeMapLinks({ url: "https://d.example/uv/" }, core, page);
  assert.deepEqual(r.links, [{ url: "https://d.example/uv/a", title: "A" }, { url: "https://d.example/uv/b/" }, { url: "https://d.example/uv/c" }, { url: "https://d.example/uv/d" }]);
  assert.equal(r.added, 2);
  const capped = mergeMapLinks({ url: "https://d.example/uv/", limit: 3 }, core, page);
  assert.equal(capped.links.length, 3);
  assert.equal(capped.added, 1);
  // A search term ranks the page's links that name it first.
  const s = mergeMapLinks({ url: "https://d.example/", search: "install" }, [], ["https://d.example/blog", "https://d.example/docs/install-guide"]);
  assert.equal(s.links[0].url, "https://d.example/docs/install-guide");
});

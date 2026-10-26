/* Tests for lib/seo.ts: the sitemap lists every public page and every post, and none
 * of the app's private routes; robots disallows exactly those routes. Run with
 * `make test-web`. */

import assert from "node:assert/strict";
import {
  isPrivatePath,
  legalDateLabel,
  LEGAL_UPDATED,
  PRIVATE_PATHS,
  robotsConfig,
  sitemapEntries,
} from "./seo.ts";
import { CATEGORY_IDS } from "./blog.ts";
import { POSTS } from "../content/blog/index.ts";

const ORIGIN = "https://example.test";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

for (const indexable of [false, true]) {
  const entries = sitemapEntries(ORIGIN, POSTS, { indexable });
  const urls = entries.map((e) => e.url);
  const paths = urls.map((u) => u.slice(ORIGIN.length) || "/");

  // Every post, with the date it last changed.
  for (const p of POSTS) {
    const e = entries.find((x) => x.url === `${ORIGIN}/blog/${p.slug}`);
    assert.ok(e, `sitemap is missing /blog/${p.slug}`);
    assert.equal(e.lastModified, p.updated ?? p.date);
  }

  // The public pages.
  for (const path of ["/", "/pricing", "/signup", "/blog", "/privacy", "/terms", "/contact", "/integrations/zoom"]) {
    assert.ok(paths.includes(path), `sitemap is missing ${path}`);
  }
  // Categories with posts, and only those.
  for (const c of CATEGORY_IDS) {
    const has = POSTS.some((p) => p.category === c);
    assert.equal(paths.includes(`/blog/category/${c}`), has, `category ${c}`);
  }
  // Proposal pages only once the prices are live.
  assert.equal(paths.includes("/features"), indexable);
  assert.equal(paths.includes("/pricing/proposed"), indexable);

  // Never a private route, the duplicate homepage, or the Zoom reviewers' test plan.
  for (const path of paths) assert.ok(!isPrivatePath(path), `sitemap lists private ${path}`);
  for (const path of ["/home", "/zoom/test-plan"]) assert.ok(!paths.includes(path), path);

  // Well formed: unique, absolute, root without a trailing slash, sane dates and priorities.
  assert.equal(new Set(urls).size, urls.length, "duplicate sitemap URL");
  assert.ok(urls.includes(ORIGIN), "root is listed without a trailing slash");
  for (const e of entries) {
    assert.ok(e.url.startsWith(`${ORIGIN}/`) || e.url === ORIGIN, e.url);
    assert.ok(e.lastModified && DATE.test(e.lastModified), `${e.url} lastModified`);
    assert.ok(e.priority > 0 && e.priority <= 1, `${e.url} priority`);
  }
}

// The blog index and categories change when their newest post does.
{
  const entries = sitemapEntries(ORIGIN, POSTS, { indexable: false });
  const newest = POSTS.map((p) => p.updated ?? p.date).sort().at(-1);
  assert.equal(entries.find((e) => e.url === `${ORIGIN}/blog`)?.lastModified, newest);
}

// Private paths: prefixes and the room wildcard, without catching public pages.
for (const path of [
  "/host",
  "/host/abc/room",
  "/host/knowledge",
  "/admin/sales",
  "/account",
  "/settings",
  "/webinars/abc/room",
  "/preview/room",
  "/api/v1/config",
  "/my-webinars",
]) {
  assert.ok(isPrivatePath(path), `${path} should be private`);
}
for (const path of ["/", "/blog/run-a-meeting", "/pricing", "/webinars/abc", "/w/abc/recording/r1", "/privacy"]) {
  assert.ok(!isPrivatePath(path), `${path} should be public`);
}

// robots: open by default, the private routes disallowed, the sitemap linked.
{
  const r = robotsConfig(ORIGIN);
  assert.equal(r.rules.allow, "/");
  assert.deepEqual(r.rules.disallow, [...PRIVATE_PATHS]);
  assert.equal(r.sitemap, `${ORIGIN}/sitemap.xml`);
}

// The legal pages print the same date the sitemap reports.
assert.equal(legalDateLabel("2026-10-17"), "October 17, 2026");
for (const d of Object.values(LEGAL_UPDATED)) assert.match(d, DATE);

console.log("seo: ok");

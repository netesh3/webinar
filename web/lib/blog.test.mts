/* Tests for the blog's content helpers (lib/blog.ts, lib/blog-markdown.ts) and the
 * posts themselves. Run with `make test-web`.
 *
 * The last block validates every published post, so a missing alt text, an unknown
 * diagram or a malformed date fails the build rather than reaching a reader. */

import assert from "node:assert/strict";
import {
  DIAGRAM_NAMES,
  escapeXml,
  formatPostDate,
  postsInCategory,
  prevNext,
  readingTime,
  relatedPosts,
  rssFeed,
  slugify,
  sortPosts,
  tableOfContents,
  validatePost,
  type Post,
} from "./blog.ts";
import { dedent, parseInline, parseMarkdown } from "./blog-markdown.ts";
import { POSTS } from "../content/blog/index.ts";

/* ------------------------------------------------------------------ slugify */

assert.equal(slugify("Go live — 15 min!"), "go-live-15-min");
assert.equal(slugify("  Q&A and polls  "), "q-a-and-polls");
assert.equal(slugify("Café déjà vu"), "cafe-deja-vu");
assert.equal(slugify("---"), "");

/* ------------------------------------------------------------------ inline */

assert.deepEqual(parseInline("plain"), [{ t: "text", v: "plain" }]);
assert.deepEqual(parseInline("a **b** c"), [
  { t: "text", v: "a " },
  { t: "strong", c: [{ t: "text", v: "b" }] },
  { t: "text", v: " c" },
]);
assert.deepEqual(parseInline("use `x*y` here"), [
  { t: "text", v: "use " },
  { t: "code", v: "x*y" },
  { t: "text", v: " here" },
]);
assert.deepEqual(parseInline("see [the guide](/blog/x)."), [
  { t: "text", v: "see " },
  { t: "link", href: "/blog/x", c: [{ t: "text", v: "the guide" }] },
  { t: "text", v: "." },
]);
// A lone asterisk or bracket is just text.
assert.deepEqual(parseInline("2 * 3 [not a link"), [{ t: "text", v: "2 * 3 [not a link" }]);
// Escapes.
assert.deepEqual(parseInline("\\*not em\\*"), [{ t: "text", v: "*not em*" }]);

/* ------------------------------------------------------------------ blocks */

assert.equal(dedent("    a\n      b\n\n    c"), "a\n  b\n\nc");

{
  const blocks = parseMarkdown(`
    ## Intro
    First line
    continues here.

    - one
    - two
      wrapped

    3. three
    4. four

    ~~~ts
    const a = 1;
    ~~~

    > [!TIP] Try this
    > Body text.

    > Just a quote.

    ![A host on stage](/blog/x.png "The stage")

    ::diagram[video-paths] Two paths

    | A | B |
    |---|---|
    | 1 | 2 |

    ---

    ## Intro
  `);
  const kinds = blocks.map((b) => b.t);
  assert.deepEqual(kinds, [
    "h", "p", "ul", "ol", "code", "callout", "quote", "img", "diagram", "table", "hr", "h",
  ]);
  const [h1, p, ul, ol, code, callout, quote, img, diagram, table, , h2] = blocks;
  assert.equal(h1.t === "h" && h1.id, "intro");
  // Duplicate headings get distinct ids.
  assert.equal(h2.t === "h" && h2.id, "intro-2");
  assert.deepEqual(p, { t: "p", c: [{ t: "text", v: "First line continues here." }] });
  assert.deepEqual(ul.t === "ul" && ul.items.map((i) => i.map((n) => (n.t === "text" ? n.v : "")).join("")), [
    "one",
    "two wrapped",
  ]);
  assert.equal(ol.t === "ol" && ol.start, 3);
  assert.deepEqual(code, { t: "code", lang: "ts", v: "const a = 1;" });
  assert.equal(callout.t === "callout" && callout.kind, "tip");
  assert.equal(callout.t === "callout" && callout.title, "Try this");
  assert.equal(callout.t === "callout" && callout.blocks[0].t, "p");
  assert.equal(quote.t === "quote" && quote.blocks.length, 1);
  assert.deepEqual(img, { t: "img", alt: "A host on stage", src: "/blog/x.png", caption: "The stage" });
  assert.deepEqual(diagram, { t: "diagram", name: "video-paths", caption: "Two paths" });
  assert.equal(table.t === "table" && table.head.length, 2);
  assert.equal(table.t === "table" && table.rows.length, 1);

  const toc = tableOfContents(blocks);
  assert.deepEqual(toc.map((e) => e.id), ["intro", "intro-2"]);
}

// A list right after a paragraph line starts a new block.
assert.deepEqual(
  parseMarkdown("Intro:\n- a\n- b").map((b) => b.t),
  ["p", "ul"],
);

/* ------------------------------------------------------------------ reading time */

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
assert.equal(readingTime(""), 1, "never less than a minute");
assert.equal(readingTime(words(220)), 1);
assert.equal(readingTime(words(221)), 2);
assert.equal(readingTime(words(1100)), 5);
// Code counts double.
assert.equal(readingTime(`~~~\n${words(220)}\n~~~`), 2);
// Markup is not words.
assert.equal(readingTime("## **Bold** heading\n\n- [link](/x)"), 1);

/* ------------------------------------------------------------------ sorting and neighbours */

const mk = (slug: string, date: string, category: Post["category"], tags: string[] = []): Post => ({
  slug,
  title: slug.toUpperCase(),
  description: "x".repeat(60),
  date,
  category,
  tags,
  body: "Hello.",
});

const sample = [
  mk("a", "2026-01-01", "tutorials", ["polls", "qa"]),
  mk("b", "2026-03-01", "tutorials", ["polls"]),
  mk("c", "2026-02-01", "engineering", ["video"]),
  mk("d", "2026-03-01", "tutorials", ["qa"]),
  mk("e", "2026-04-01", "engineering", ["polls", "qa"]),
];

assert.deepEqual(sortPosts(sample).map((p) => p.slug), ["e", "b", "d", "c", "a"], "newest first, title breaks ties");
assert.deepEqual(postsInCategory(sample, "tutorials").map((p) => p.slug), ["b", "d", "a"]);
assert.deepEqual(postsInCategory(sample, "product"), []);

{
  const { prev, next } = prevNext(sample, "d");
  assert.equal(prev?.slug, "a", "prev is the older post in the same category");
  assert.equal(next?.slug, "b", "next is the newer one");
  assert.equal(prevNext(sample, "b").next, null);
  assert.equal(prevNext(sample, "a").prev, null);
  assert.deepEqual(prevNext(sample, "missing"), { prev: null, next: null });
}

{
  // a shares polls+qa with e (4), polls with b (2+1), qa with d (2+1); c shares nothing.
  assert.deepEqual(relatedPosts(sample, "a", 3).map((p) => p.slug), ["e", "b", "d"]);
  assert.deepEqual(relatedPosts(sample, "a", 10).map((p) => p.slug), ["e", "b", "d", "c"]);
  assert.ok(!relatedPosts(sample, "c").some((p) => p.slug === "c"), "never itself");
  assert.deepEqual(relatedPosts(sample, "missing"), []);
}

/* ------------------------------------------------------------------ dates and feed */

assert.equal(formatPostDate("2026-10-24"), "24 October 2026");
assert.equal(escapeXml(`<a href="x">Q&A</a>`), "&lt;a href=&quot;x&quot;&gt;Q&amp;A&lt;/a&gt;");
{
  const xml = rssFeed("https://example.com", sortPosts(sample));
  assert.ok(xml.startsWith("<?xml"));
  assert.equal(xml.match(/<item>/g)?.length, sample.length);
  assert.ok(xml.includes("<link>https://example.com/blog/e</link>"));
  assert.ok(xml.includes('href="https://example.com/blog/rss.xml"'));
}

/* ------------------------------------------------------------------ validation */

assert.deepEqual(validatePost(mk("ok-post", "2026-01-01", "tutorials"), DIAGRAM_NAMES), []);
{
  const bad: Post = {
    ...mk("Bad Slug", "2026-1-1", "tutorials", ["Polls"]),
    description: "short",
    body: "![](/blog/x.png)\n\n::diagram[nope]",
  };
  const errors = validatePost(bad, DIAGRAM_NAMES);
  for (const fragment of ["slug", "description", "date", "tag", "alt text", "unknown diagram"])
    assert.ok(errors.some((e) => e.includes(fragment)), `expected an error about ${fragment}`);
}

/* ------------------------------------------------------------------ the published posts */

assert.ok(POSTS.length > 0);
assert.equal(new Set(POSTS.map((p) => p.slug)).size, POSTS.length, "slugs are unique");
for (const p of POSTS) assert.deepEqual(validatePost(p, DIAGRAM_NAMES), [], p.slug);

// Internal links between posts point at posts that exist.
for (const p of POSTS) {
  for (const m of p.body.matchAll(/\]\((\/blog\/[^)#\s]+)/g)) {
    const target = m[1].replace(/^\/blog\//, "");
    if (target.startsWith("category/") || target === "rss.xml") continue;
    assert.ok(POSTS.some((q) => q.slug === target), `${p.slug} links to missing post ${m[1]}`);
  }
}

console.log(`blog: ok (${POSTS.length} posts)`);

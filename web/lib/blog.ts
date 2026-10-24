/* The blog: types and the pure helpers behind /blog.
 *
 * Posts are TypeScript modules under content/blog/ that export a `Post` — metadata plus
 * a Markdown body in a template string (see lib/blog-markdown.ts for the subset it
 * understands). They are imported, not read from disk, so every page builds statically
 * and the Workers bundle never needs a filesystem. docs/content-guide.md is the
 * author's side of this file.
 *
 * Nothing here imports React or Next, so `make test-web` runs it directly. */

import { parseMarkdown, plainText, type Block } from "./blog-markdown.ts";

export { slugify } from "./blog-markdown.ts";

export const BLOG_AUTHOR = "Webinar Liv team";

export type BlogCategory = "tutorials" | "engineering" | "product";

/** Order here is the order of the filter chips on /blog. */
export const CATEGORIES: Record<BlogCategory, { label: string; blurb: string }> = {
  tutorials: {
    label: "Tutorials",
    blurb: "Step-by-step guides to hosting with Webinar Liv.",
  },
  engineering: {
    label: "Engineering",
    blurb: "How the platform is built, and why it is built that way.",
  },
  product: {
    label: "Product",
    blurb: "What changed, and what it means for your sessions.",
  },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES) as BlogCategory[];

export function isCategory(value: string): value is BlogCategory {
  return Object.hasOwn(CATEGORIES, value);
}

export type Post = {
  /** URL segment: /blog/<slug>. Lowercase letters, digits and hyphens. */
  slug: string;
  title: string;
  /** One or two sentences. Used on cards, in search results and in the feed. */
  description: string;
  /** First published, YYYY-MM-DD. */
  date: string;
  /** Last meaningful edit, YYYY-MM-DD. Optional. */
  updated?: string;
  category: BlogCategory;
  /** Lowercase, used for related posts. */
  tags: string[];
  /** The Markdown body. */
  body: string;
};

export type TocEntry = { id: string; text: string; level: 2 | 3 };

/** Words per minute for prose. Code is read slower, so it counts double. */
const WPM = 220;

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Whole minutes to read a body, never less than one. */
export function readingTime(body: string): number {
  const blocks = parseMarkdown(body);
  let words = 0;
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "code") words += countWords(b.v) * 2;
      else if (b.t === "callout" || b.t === "quote") walk(b.blocks);
      else words += countWords(plainText(b));
    }
  };
  walk(blocks);
  return Math.max(1, Math.ceil(words / WPM));
}

/** Newest first; same day falls back to title so the order is stable between builds. */
export function sortPosts<T extends Pick<Post, "date" | "title">>(posts: readonly T[]): T[] {
  return [...posts].sort((a, b) =>
    a.date === b.date ? a.title.localeCompare(b.title) : a.date < b.date ? 1 : -1,
  );
}

export function postsInCategory<T extends Pick<Post, "category" | "date" | "title">>(
  posts: readonly T[],
  category: BlogCategory,
): T[] {
  return sortPosts(posts.filter((p) => p.category === category));
}

/** Neighbours within the same category, in reading order: `prev` is older, `next` newer. */
export function prevNext<T extends Pick<Post, "slug" | "category" | "date" | "title">>(
  posts: readonly T[],
  slug: string,
): { prev: T | null; next: T | null } {
  const self = posts.find((p) => p.slug === slug);
  if (!self) return { prev: null, next: null };
  const list = postsInCategory(posts, self.category);
  const i = list.findIndex((p) => p.slug === slug);
  return { prev: list[i + 1] ?? null, next: list[i - 1] ?? null };
}

/** Up to `limit` other posts, most shared tags first, then same category, then newest. */
export function relatedPosts<T extends Pick<Post, "slug" | "category" | "tags" | "date" | "title">>(
  posts: readonly T[],
  slug: string,
  limit = 3,
): T[] {
  const self = posts.find((p) => p.slug === slug);
  if (!self) return [];
  const tags = new Set(self.tags);
  const scored = sortPosts(posts.filter((p) => p.slug !== slug)).map((p) => ({
    p,
    score:
      p.tags.filter((t) => tags.has(t)).length * 2 + (p.category === self.category ? 1 : 0),
  }));
  // Array.prototype.sort is stable, so equal scores keep newest-first from sortPosts.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.p);
}

/** The headings a table of contents lists. Ids match the ones the renderer puts on them. */
export function tableOfContents(blocks: Block[]): TocEntry[] {
  return blocks.flatMap((b) =>
    b.t === "h" ? [{ id: b.id, text: plainText(b), level: b.level }] : [],
  );
}

/** Hand-drawn SVG diagrams a post can place with `::diagram[name]`. The components live
 *  in components/blog/diagrams.tsx, keyed by these names (the type keeps the two in step). */
export const DIAGRAM_NAMES = [
  "video-paths",
  "simulcast-layers",
  "latency-scale",
  "server-lifecycle",
  "webinar-timeline",
  "simulive-clock",
] as const;

export type DiagramName = (typeof DIAGRAM_NAMES)[number];

/** A table of contents is clutter on a short post. */
export const TOC_MIN_HEADINGS = 4;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Problems a post would ship with. The test suite runs this over every post, so a
 *  missing alt text or a typo'd diagram name fails `make test-web`, not the reader. */
export function validatePost(post: Post, diagramNames: readonly string[]): string[] {
  const errors: string[] = [];
  const where = post.slug || "(no slug)";
  if (!SLUG_RE.test(post.slug)) errors.push(`${where}: slug must be lowercase-with-hyphens`);
  if (!post.title.trim()) errors.push(`${where}: missing title`);
  if (post.description.trim().length < 50)
    errors.push(`${where}: description should be at least 50 characters`);
  if (post.description.length > 200)
    errors.push(`${where}: description should be at most 200 characters`);
  if (!DATE_RE.test(post.date)) errors.push(`${where}: date must be YYYY-MM-DD`);
  if (post.updated && !DATE_RE.test(post.updated))
    errors.push(`${where}: updated must be YYYY-MM-DD`);
  if (!isCategory(post.category)) errors.push(`${where}: unknown category ${post.category}`);
  for (const t of post.tags)
    if (t !== t.toLowerCase()) errors.push(`${where}: tag "${t}" must be lowercase`);

  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "img" && !b.alt.trim()) errors.push(`${where}: image ${b.src} has no alt text`);
      if (b.t === "diagram" && !diagramNames.includes(b.name))
        errors.push(`${where}: unknown diagram "${b.name}"`);
      if (b.t === "callout" || b.t === "quote") walk(b.blocks);
    }
  };
  walk(parseMarkdown(post.body));
  return errors;
}

/** "2026-10-24" → "24 October 2026". Parsed as UTC so the day never shifts. */
export function formatPostDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** RFC 822 date for RSS. */
export function rssDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 9)).toUTCString();
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The RSS 2.0 document for /blog/rss.xml. `posts` should already be sorted. */
export function rssFeed(origin: string, posts: readonly Post[]): string {
  const items = posts
    .map((p) => {
      const url = `${origin}/blog/${p.slug}`;
      return [
        "    <item>",
        `      <title>${escapeXml(p.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <pubDate>${rssDate(p.date)}</pubDate>`,
        `      <category>${escapeXml(CATEGORIES[p.category].label)}</category>`,
        `      <description>${escapeXml(p.description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Webinar Liv blog</title>
    <link>${origin}/blog</link>
    <atom:link href="${origin}/blog/rss.xml" rel="self" type="application/rss+xml" />
    <description>Tutorials and engineering notes from the Webinar Liv team.</description>
    <language>en</language>
${posts[0] ? `    <lastBuildDate>${rssDate(posts[0].updated ?? posts[0].date)}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;
}

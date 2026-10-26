/* What search engines are told about the site: the sitemap's entries and the robots
 * rules. Kept free of Next and "@/" imports so lib/seo.test.mts can run it with plain
 * Node; app/sitemap.ts and app/robots.ts are thin wrappers around it.
 *
 * Public, indexable pages are listed. App routes (host portal, admin, account, rooms,
 * previews) are never listed, and robots asks crawlers to stay out of them. Webinar
 * registration pages and shared recordings are left crawlable but unlisted: they are
 * the host's content, and link previews in chat apps need to fetch them. */

import { CATEGORY_IDS, type BlogCategory, type Post } from "./blog.ts";

type ChangeFrequency = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

export type SitemapEntry = {
  url: string;
  lastModified?: string;
  changeFrequency: ChangeFrequency;
  priority: number;
};

/** "Last updated" on the legal pages, as YYYY-MM-DD. The pages show these dates, and
 *  the sitemap reports them, so bump the date here when the text changes. */
/** When /contact last changed (its sitemap date). */
export const CONTACT_UPDATED = "2026-10-27";

export const LEGAL_UPDATED = {
  privacy: "2026-10-27",
  terms: "2026-09-11",
  zoom: "2026-10-17",
} as const;

/** The last meaningful change to the marketing pages (home, pricing, features, sign
 *  up). A fixed date rather than the build time: a sitemap that says every page changed
 *  on every deploy teaches crawlers to ignore lastModified. Bump it with the copy. */
export const MARKETING_UPDATED = "2026-10-24";

/** "2026-10-17" → "October 17, 2026", the format the legal pages print. */
export function legalDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Route prefixes that are the app, not the website. Never in the sitemap, and
 *  disallowed in robots. A trailing "/" matches only below it; "*" is a wildcard. */
export const PRIVATE_PATHS = [
  "/account",
  "/admin",
  "/api/",
  "/auth/",
  "/browse",
  "/forgot-password",
  "/host",
  "/login",
  "/mock/",
  "/my-webinars",
  "/preview",
  "/recorder-template",
  "/recordings/",
  "/reset-password",
  "/settings",
  "/verify-email",
  "/webinars/*/room",
] as const;

/** Whether a path falls under PRIVATE_PATHS, with robots.txt's prefix and "*" rules. */
export function isPrivatePath(path: string): boolean {
  return PRIVATE_PATHS.some((rule) => {
    const pattern = rule
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^]*");
    return new RegExp(`^${pattern}`).test(path);
  });
}

/** The blog feed, for <link rel="alternate"> on every blog page. */
export const RSS_ALTERNATE = {
  "application/rss+xml": [{ url: "/blog/rss.xml", title: "Webinar Liv blog" }],
};

function latest(dates: string[]): string | undefined {
  return dates.length ? [...dates].sort().at(-1) : undefined;
}

const changed = (p: Post) => p.updated ?? p.date;

/** Every public page, then every post. `indexable` is lib/plans' indexable(): the
 *  proposal pages (/features, /pricing/proposed) are noindex until it is true. */
export function sitemapEntries(
  origin: string,
  posts: readonly Post[],
  opts: { indexable: boolean },
): SitemapEntry[] {
  const pages: (Omit<SitemapEntry, "url"> & { path: string })[] = [
    { path: "/", lastModified: MARKETING_UPDATED, changeFrequency: "weekly", priority: 1 },
    { path: "/pricing", lastModified: MARKETING_UPDATED, changeFrequency: "weekly", priority: 0.9 },
    ...(opts.indexable
      ? [
          { path: "/features", lastModified: MARKETING_UPDATED, changeFrequency: "weekly" as const, priority: 0.8 },
          { path: "/pricing/proposed", lastModified: MARKETING_UPDATED, changeFrequency: "weekly" as const, priority: 0.7 },
        ]
      : []),
    { path: "/signup", lastModified: MARKETING_UPDATED, changeFrequency: "monthly", priority: 0.8 },
    { path: "/blog", lastModified: latest(posts.map(changed)), changeFrequency: "weekly", priority: 0.7 },
    // Only categories that have posts; an empty listing is not worth indexing.
    ...CATEGORY_IDS.filter((c: BlogCategory) => posts.some((p) => p.category === c)).map((c) => ({
      path: `/blog/category/${c}`,
      lastModified: latest(posts.filter((p) => p.category === c).map(changed)),
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
    { path: "/privacy", lastModified: LEGAL_UPDATED.privacy, changeFrequency: "yearly", priority: 0.3 },
    { path: "/terms", lastModified: LEGAL_UPDATED.terms, changeFrequency: "yearly", priority: 0.3 },
    { path: "/contact", lastModified: CONTACT_UPDATED, changeFrequency: "yearly", priority: 0.4 },
    { path: "/integrations/zoom", lastModified: LEGAL_UPDATED.zoom, changeFrequency: "yearly", priority: 0.3 },
    // Not listed: /home (the same page as /, canonical there), /zoom/test-plan (for the
    // Zoom reviewers, noindex), and everything in PRIVATE_PATHS.
  ];
  return [
    ...pages.map(({ path, ...rest }) => ({
      // No trailing slash on the root, matching the homepage's canonical URL.
      url: `${origin}${path === "/" ? "" : path}`,
      ...rest,
    })),
    ...posts.map((p) => ({
      url: `${origin}/blog/${p.slug}`,
      lastModified: changed(p),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}

/** robots.txt: everything is allowed except the app, and the sitemap is linked. */
export function robotsConfig(origin: string) {
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] },
    sitemap: `${origin}/sitemap.xml`,
  };
}

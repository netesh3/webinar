import type { MetadataRoute } from "next";
import { POSTS } from "@/content/blog";
import { CATEGORY_IDS } from "@/lib/blog";
import { indexable } from "@/lib/plans";
import { siteOrigin } from "@/lib/site-origin";

/* Public pages only. /home is the same page as / and is left out so it is not
 * indexed twice. Host, account, room and preview routes are not listed, and
 * neither is /login, which has nothing to rank for. Blog posts come from content/blog. */

const PAGES: { path: string; changeFrequency: "weekly" | "monthly" | "yearly"; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/pricing", changeFrequency: "weekly", priority: 0.9 },
  // Listed once its prices are the live ones (lib/plans.ts PLANS_STATUS); noindex until then.
  ...(indexable() ? [{ path: "/features", changeFrequency: "weekly" as const, priority: 0.8 }] : []),
  { path: "/signup", changeFrequency: "monthly", priority: 0.8 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/integrations/zoom", changeFrequency: "yearly", priority: 0.3 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.7 },
  // Only categories that have posts; an empty listing is not worth indexing.
  ...CATEGORY_IDS.filter((c) => POSTS.some((p) => p.category === c)).map((c) => ({
    path: `/blog/category/${c}`,
    changeFrequency: "weekly" as const,
    priority: 0.5,
  })),
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const pages: MetadataRoute.Sitemap = PAGES.map(({ path, changeFrequency, priority }) => ({
    // No trailing slash on the root, matching the homepage's canonical URL.
    url: `${origin}${path === "/" ? "" : path}`,
    changeFrequency,
    priority,
  }));
  // Every blog post, with the date it last changed.
  const posts: MetadataRoute.Sitemap = POSTS.map((p) => ({
    url: `${origin}/blog/${p.slug}`,
    lastModified: p.updated ?? p.date,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  return [...pages, ...posts];
}

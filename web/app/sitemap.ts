import type { MetadataRoute } from "next";
import { POSTS } from "@/content/blog";
import { indexable } from "@/lib/plans";
import { sitemapEntries } from "@/lib/seo";
import { siteOrigin } from "@/lib/site-origin";

/* Public pages and every blog post. Which pages, their dates and priorities, and what
 * is kept out live in lib/seo.ts, which lib/seo.test.mts checks. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(await siteOrigin(), POSTS, { indexable: indexable() });
}

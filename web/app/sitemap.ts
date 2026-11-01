import type { MetadataRoute } from "next";
import { POSTS } from "@/content/blog";
import { api } from "@/lib/api";
import { downloadsVisible } from "@/lib/downloads-visibility";
import { indexable } from "@/lib/plans";
import { sitemapEntries } from "@/lib/seo";
import { siteOrigin } from "@/lib/site-origin";

/* Public pages and every blog post. Which pages, their dates and priorities, and what
 * is kept out live in lib/seo.ts, which lib/seo.test.mts checks. /download only while an
 * admin has it switched on (from /api/config; left out when the API cannot say). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [origin, config] = await Promise.all([siteOrigin(), api.config().catch(() => null)]);
  return sitemapEntries(origin, POSTS, { indexable: indexable(), downloadsVisible: downloadsVisible(config) });
}

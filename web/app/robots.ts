import type { MetadataRoute } from "next";
import { robotsConfig } from "@/lib/seo";
import { siteOrigin } from "@/lib/site-origin";

/** robots.txt: the public site is open, the app routes (lib/seo.ts PRIVATE_PATHS)
 *  are disallowed, and crawlers are pointed at /sitemap.xml. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsConfig(await siteOrigin());
}

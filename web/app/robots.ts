import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

/** Points crawlers at /sitemap.xml. Allows the same paths as having no robots
 *  file, which is what the site had before. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${origin}/sitemap.xml`,
  };
}

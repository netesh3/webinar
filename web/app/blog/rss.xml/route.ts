import { POSTS } from "@/content/blog";
import { rssFeed } from "@/lib/blog";
import { siteOrigin } from "@/lib/site-origin";

/* /blog/rss.xml. The posts are compiled in, so the only per-request input is the site
 * origin (a self-hosted install advertises its own domain, as sitemap.xml does). */
export async function GET() {
  const xml = rssFeed(await siteOrigin(), POSTS);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

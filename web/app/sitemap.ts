import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

/* Public pages only. /home is the same page as / and is left out so it is not
 * indexed twice. Host, account, room and preview routes are not listed. */

const PAGES: { path: string; changeFrequency: "weekly" | "monthly" | "yearly"; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/signup", changeFrequency: "monthly", priority: 0.8 },
  { path: "/login", changeFrequency: "monthly", priority: 0.5 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  return PAGES.map(({ path, changeFrequency, priority }) => ({
    url: path === "/" ? `${origin}/` : `${origin}${path}`,
    changeFrequency,
    priority,
  }));
}

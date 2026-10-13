import { api } from "@/lib/api";

/** Public site origin for sitemap and robots.
 *
 *  Comes from the API's webBaseUrl, the same value share links use, so a
 *  self-hosted install advertises its own domain. Falls back to the production
 *  site when config cannot be read. */
export async function siteOrigin(): Promise<string> {
  const config = await api.config().catch(() => null);
  const raw = config?.webBaseUrl?.trim() || "https://webinarliv.com";
  return raw.replace(/\/+$/, "");
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DownloadChooser } from "@/components/marketing/download-page";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { TopNav } from "@/components/top-nav";
import { api } from "@/lib/api";
import { DOWNLOADS_HIDDEN_REDIRECT, downloadPageAccess, downloadsVisible } from "@/lib/downloads-visibility";
import { detectPlatform, platformOffers } from "@/lib/downloads";
import { loadDownloadsManifest } from "@/lib/downloads-server";
import { viewerIsAdmin } from "@/lib/viewer-server";

const DESCRIPTION =
  "Download Webinar Liv for Mac, Windows, Android and iPhone. Host and join webinars from an app, or keep using any browser.";

export const metadata: Metadata = {
  title: "Download the app",
  description: DESCRIPTION,
  alternates: { canonical: "/download" },
  openGraph: {
    title: "Get the Webinar Liv app",
    description: DESCRIPTION,
    url: "/download",
    type: "website",
  },
};

/* Open to everyone while an admin has the Downloads page switched on (Admin -> Dashboard ->
 * Site settings, lib/downloads-visibility.ts). While it is off, a 307 home for everyone but
 * admins, who see the page with a "Hidden from users" notice so they can check it before
 * turning it on. A redirect rather than a 404 so that downloads.webinarliv.com/ (a Worker
 * that 302s here, deploy/cloudflare/downloads-root) and old links land somewhere useful
 * without the Worker changing. It is not in middleware's matcher. Rendered per request,
 * because the button it leads with depends on the visitor's user agent; the manifest behind
 * it is cached for five minutes (lib/downloads-server.ts). Reachable from inside our own
 * apps too, though nothing there links to it. */
export default async function DownloadRoute() {
  const config = await api.config().catch(() => null);
  const visible = downloadsVisible(config);
  const access = downloadPageAccess(visible, visible ? null : { isAdmin: await viewerIsAdmin() });
  if (access === "redirect") redirect(DOWNLOADS_HIDDEN_REDIRECT);

  const [manifest, h] = await Promise.all([loadDownloadsManifest(), headers()]);
  const offers = platformOffers(manifest);
  const platform = detectPlatform(h.get("user-agent") ?? "");
  return (
    <>
      <TopNav />
      <main className="flex-1">
        <div className="home">
          {access === "admin-preview" && (
            <p
              role="status"
              className="mx-auto mt-4 w-fit max-w-[calc(100%-2rem)] rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-center text-[13px] font-medium text-amber-900"
            >
              Hidden from users. Only admins can open this page. Turn it on in Admin, Dashboard, Site settings.
            </p>
          )}
          <div className="lp lp-download">
            <DownloadChooser offers={offers} serverPlatform={platform} />
          </div>
          <HomeLegalFooter />
        </div>
      </main>
    </>
  );
}

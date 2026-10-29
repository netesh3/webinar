import type { Metadata } from "next";
import { headers } from "next/headers";
import { DownloadChooser } from "@/components/marketing/download-page";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { TopNav } from "@/components/top-nav";
import { detectPlatform, platformOffers } from "@/lib/downloads";
import { loadDownloadsManifest } from "@/lib/downloads-server";

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

/* Open to everyone: it is not in middleware's matcher. Rendered per request, because the
 * button it leads with depends on the visitor's user agent; the manifest behind it is
 * cached for five minutes (lib/downloads-server.ts). Reachable from inside our own apps
 * too, though nothing there links to it. */
export default async function DownloadRoute() {
  const [manifest, h] = await Promise.all([loadDownloadsManifest(), headers()]);
  const offers = platformOffers(manifest);
  const platform = detectPlatform(h.get("user-agent") ?? "");
  return (
    <>
      <TopNav />
      <main className="flex-1">
        <div className="home">
          <div className="lp lp-download">
            <DownloadChooser offers={offers} serverPlatform={platform} />
          </div>
          <HomeLegalFooter />
        </div>
      </main>
    </>
  );
}

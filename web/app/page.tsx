import { ContinueAsPreviewHost } from "@/components/continue-as-preview-host";
import {
  HomePage,
  SignedInHomeRedirect,
} from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";
import { homeJsonLd, homeMetadata } from "@/lib/home-seo";
import { siteOrigin } from "@/lib/site-origin";

export const metadata = homeMetadata;

/* Front door.
 *
 * Brand marketing homepage; signed-in users redirect to /host or /my-webinars.
 * Always-on marketing alias: /home (even when signed in).
 */

export default async function HomeRoute() {
  const jsonLd = homeJsonLd(await siteOrigin());
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SignedInHomeRedirect />
      <TopNav />
      <main className="flex-1">
        <ContinueAsPreviewHost className="mx-auto max-w-6xl px-4 pt-4 sm:px-5" />
        <HomePage />
      </main>
    </>
  );
}

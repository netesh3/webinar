import { GoogleOneTap } from "@/components/google-one-tap";
import { ContinueAsPreviewHost } from "@/components/continue-as-preview-host";
import { HomePage } from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";
import { homeMetadata } from "@/lib/home-seo";

export const metadata = homeMetadata;

/* Always show marketing — even when auth bypass or signed-in would redirect `/`.
 * Belt-and-suspenders with /?marketing=1. */

export default function MarketingHomeAlias() {
  return (
    <>
      <TopNav />
      <GoogleOneTap next="/browse" />
      <main className="flex-1">
        <ContinueAsPreviewHost className="mx-auto max-w-6xl px-4 pt-4 sm:px-5" />
        <HomePage />
      </main>
    </>
  );
}

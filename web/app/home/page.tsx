import { ContinueAsPreviewHost } from "@/components/continue-as-preview-host";
import { GoogleOneTap } from "@/components/google-one-tap";
import { HomePage } from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";

/* Always show marketing — even when auth bypass or signed-in would redirect `/`.
 * Belt-and-suspenders with /?marketing=1. */

export default function MarketingHomeAlias() {
  return (
    <>
      <GoogleOneTap next="/browse" />
      <TopNav />
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-5">
          <ContinueAsPreviewHost />
        </div>
        <HomePage />
      </main>
    </>
  );
}

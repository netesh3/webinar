import { cookies } from "next/headers";
import { BrowseScreen } from "@/components/browse-screen";
import { ContinueAsPreviewHost } from "@/components/continue-as-preview-host";
import { GoogleOneTap } from "@/components/google-one-tap";
import {
  HomePage,
  SignedInHomeRedirect,
} from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";
import { UI_COOKIE, resolveUiRedesign } from "@/lib/ui-redesign-flag";

/* Front door.
 *
 * Classic (default in production): browse catalogue — same as main before the
 * redesign. New UI: brand marketing homepage; signed-in users redirect away.
 *
 * Switch: ?ui=new|classic, cookie webcast_ui, or NEXT_PUBLIC_UI_REDESIGN=1.
 */

export default async function HomeRoute() {
  const jar = await cookies();
  const redesign = resolveUiRedesign({ cookie: jar.get(UI_COOKIE)?.value });

  if (!redesign) {
    return (
      <>
        <TopNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
          <ContinueAsPreviewHost className="mb-4" />
          <BrowseScreen />
        </main>
      </>
    );
  }

  return (
    <>
      <SignedInHomeRedirect />
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

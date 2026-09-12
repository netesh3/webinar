import { ContinueAsPreviewHost } from "@/components/continue-as-preview-host";
import { GoogleOneTap } from "@/components/google-one-tap";
import {
  HomePage,
  SignedInHomeRedirect,
} from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";

/* Front door.
 *
 * Brand marketing homepage; signed-in users redirect to /host or /browse.
 * Always-on marketing alias: /home (even when signed in).
 */

export default function HomeRoute() {
  return (
    <>
      <SignedInHomeRedirect />
      <GoogleOneTap next="/browse" />
      <TopNav />
      <main className="flex-1">
        <ContinueAsPreviewHost className="mx-auto max-w-6xl px-4 pt-4 sm:px-5" />
        <HomePage />
      </main>
    </>
  );
}

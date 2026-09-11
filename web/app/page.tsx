import { GoogleOneTap } from "@/components/google-one-tap";
import {
  HomePage,
  SignedInHomeRedirect,
} from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";

/* Brand homepage — public marketing for Webcast.
 *
 * Signed-in users (and local auth bypass) are redirected to the app; see
 * middleware + SignedInHomeRedirect. Logged-out visitors may see Google One Tap.
 */
export default function MarketingHomePage() {
  return (
    <>
      <SignedInHomeRedirect />
      <GoogleOneTap next="/browse" />
      <TopNav />
      <main className="flex-1">
        <HomePage />
      </main>
    </>
  );
}

import { HomePage } from "@/components/marketing/home-page";
import { TopNav } from "@/components/top-nav";

/* Brand homepage — public marketing for Webcast.
 *
 * Browse lives at /browse. Signed-in hosts still see this page with contextual
 * CTAs ("Go to Hosting") so `/` remains the product's brand home.
 */
export default function MarketingHomePage() {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        <HomePage />
      </main>
    </>
  );
}

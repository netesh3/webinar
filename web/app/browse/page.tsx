import { BrowseScreen } from "@/components/browse-screen";
import { TopNav } from "@/components/top-nav";

/* Browse catalogue — sessions you're involved in (or the public list when signed out).
 *
 * Marketing lives at `/`. This route is the product catalogue; keep it a single list.
 * Client-rendered for the same cookie/session reason as /host and /my-webinars.
 */
export default function BrowsePage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        <BrowseScreen />
      </main>
    </>
  );
}

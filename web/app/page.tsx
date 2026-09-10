import { BrowseScreen } from "@/components/browse-screen";
import { TopNav } from "@/components/top-nav";

/* The front page.
 *
 * A shell only. The list it shows is now scoped to whoever is asking, and the session is an
 * httpOnly cookie the BROWSER holds — a Server Component's fetch runs in Node with no cookie
 * jar, so fetching here answered 401 for everybody and rendered "sign in" to people who were
 * already signed in. See the note in BrowseScreen.
 *
 * Same shape as /host and /my-webinars, which are client-rendered for the identical reason.
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

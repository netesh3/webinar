import { MyWebinarsList } from "@/components/my-webinars-list";
import { TopNav } from "@/components/top-nav";

/* No data fetched here on purpose.
 *
 * This page used to call api.listWebinars() server-side and hand the whole catalogue to
 * the list, which filtered it down to the caller's registrations in the browser. The list
 * now resolves each registration together with its webinar — from the join-key lookup for
 * guests, from /api/me/registrations for accounts — so there is nothing for the server to
 * fetch and nothing extra to put in the payload.
 *
 * Both of those need the browser: one reads join keys out of localStorage, the other needs
 * the session cookie. So the page is a shell and the client does the asking.
 */
export default function MyWebinarsPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-8">
        <div className="mb-6">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">
            Attending
          </h1>
          <p className="mt-1.5 text-[14px] text-ink-2">
            Everything you&apos;ve registered for, with your personal join key.
          </p>
        </div>

        <MyWebinarsList />
      </main>
    </>
  );
}

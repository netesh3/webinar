import { TopNav } from "@/components/top-nav";

/* The host portal's chrome: top nav + centred content.
 *
 * No host sidebar — product areas live in TopNav (Browse | My webinars |
 * Hosting). Hosting pages use page headers, Create CTAs, and in-page segments
 * (Upcoming / Past / Drafts, or Admit / Attendees / …) instead of a second rail
 * that re-listed the same destinations.
 *
 * This lives in a (portal) route group rather than directly at app/host/ so
 * /host/[id]/room does NOT inherit it. Layouts nest; with this at
 * app/host/layout.tsx the live room would render inside a max-w-6xl column with
 * a nav bar above it.
 */
export default function HostPortalLayout({
  children,
}: LayoutProps<"/host">) {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        {children}
      </main>
    </>
  );
}

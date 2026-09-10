import { HostSidebar } from "@/components/host-sidebar";
import { TopNav } from "@/components/top-nav";

/* The host portal's chrome: top nav, sidebar, centred content column.
 *
 * This lives in a (portal) route group rather than directly at app/host/ for one
 * reason: /host/[id]/room must NOT inherit it. Layouts nest, so with this file at
 * app/host/layout.tsx the live room rendered inside a max-w-6xl column with a nav
 * bar above it and a sidebar beside it — a 100dvh-tall room starting below a
 * 56px nav, with its control bar pushed off the bottom of the screen.
 *
 * The group changes nothing about the URLs: /host, /host/new and /host/[id] are
 * unaffected, and /host/[id]/room now gets only the root layout, which is what a
 * full-screen video call needs.
 */
export default function HostPortalLayout({
  children,
}: LayoutProps<"/host">) {
  return (
    <>
      <TopNav />
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-7 px-4 py-8 sm:px-5">
        <HostSidebar />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </>
  );
}

import { HostSidebar } from "@/components/host-sidebar";
import { TopNav } from "@/components/top-nav";
import { cookies } from "next/headers";
import { UI_COOKIE, resolveUiRedesign } from "@/lib/ui-redesign-flag";

/* The host portal's chrome.
 *
 * Redesign: top nav only (Browse | My webinars | Hosting) — no second sidebar.
 * Classic: top nav + host sidebar (Webinars / Schedule / Account).
 */

export default async function HostPortalLayout({
  children,
}: LayoutProps<"/host">) {
  const jar = await cookies();
  const redesign = resolveUiRedesign({ cookie: jar.get(UI_COOKIE)?.value });

  if (redesign) {
    return (
      <>
        <TopNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
          {children}
        </main>
      </>
    );
  }

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

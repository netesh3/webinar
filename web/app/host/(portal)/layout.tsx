import { TopNav } from "@/components/top-nav";

/* The host portal's chrome: top nav only (Browse | My Webinar | Host Webinar). */

export default function HostPortalLayout({ children }: LayoutProps<"/host">) {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        {children}
      </main>
    </>
  );
}

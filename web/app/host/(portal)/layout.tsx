import { TopNav } from "@/components/top-nav";

/* The host portal's chrome: top nav only (Host Webinar, plus the account menu). */

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

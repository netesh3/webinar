"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TopNav } from "./top-nav";

/* Your webinars sits in the usual padded column. Messages fills the window
 * under the top bar — the list and the thread scroll, the page does not. */

export function HostPortalFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const inbox =
    pathname === "/host/messages" || pathname.startsWith("/host/messages/");
  if (inbox) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-surface">
        <TopNav />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    );
  }
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        {children}
      </main>
    </>
  );
}

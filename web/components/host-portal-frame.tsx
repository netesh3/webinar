import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

/* The host portal's chrome: the sidebar, and a content column that fills the
 * width and height beside it. Pages lay themselves out inside that column. */

export function HostPortalFrame({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <main className="flex w-full min-w-0 flex-1 flex-col px-4 pb-8 sm:px-6">
        {children}
      </main>
    </AppShell>
  );
}

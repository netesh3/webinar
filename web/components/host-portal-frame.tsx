import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

/* The host portal's chrome: the sidebar, and the same padded column every
 * page already used. The column is unchanged — only the top bar moved. */

export function HostPortalFrame({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        {children}
      </main>
    </AppShell>
  );
}

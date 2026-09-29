import type { ReactNode } from "react";
import { TopNav } from "./top-nav";

/* The host portal's chrome. Every page, including Messages, sits in the same
 * padded column under the same top nav. */

export function HostPortalFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        {children}
      </main>
    </>
  );
}

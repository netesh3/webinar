"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { inOwnApp } from "@/lib/downloads";

/* A link to /download, for the site footer and the account menu. Hidden inside our own
 * apps (the phone app's user agent, the desktop app's window.webinarlivDesktop): there is
 * nothing to download from in there. Rendered on the server, so ordinary visitors and
 * crawlers see it in the HTML; the app hides it as it hydrates. */

const noSubscribe = () => () => {};

function readInOwnApp(): boolean {
  return inOwnApp(navigator.userAgent || "", "webinarlivDesktop" in window);
}

export function useInOwnApp(): boolean {
  return useSyncExternalStore(noSubscribe, readInOwnApp, () => false);
}

export function GetAppLink({
  className,
  children,
  before,
  onClick,
}: {
  className?: string;
  children: ReactNode;
  /** Drawn ahead of the link and hidden with it (a separator, say). */
  before?: ReactNode;
  onClick?: () => void;
}) {
  if (useInOwnApp()) return null;
  return (
    <>
      {before}
      <Link href="/download" className={className} onClick={onClick}>
        {children}
      </Link>
    </>
  );
}

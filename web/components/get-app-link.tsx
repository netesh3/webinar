"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { inOwnApp } from "@/lib/downloads";
import { downloadsVisible, showGetAppLink } from "@/lib/downloads-visibility";
import { useAppConfig } from "./providers";

/* A link to /download, for the site footer and the account menu. Hidden while an admin has
 * the Downloads page switched off (lib/downloads-visibility.ts, from /api/config), and inside
 * our own apps (the phone app's user agent, the desktop app's window.webinarlivDesktop):
 * there is nothing to download from in there. Rendered on the server, so ordinary visitors
 * and crawlers see it in the HTML; the app hides it as it hydrates. */

const noSubscribe = () => () => {};

function readInOwnApp(): boolean {
  return inOwnApp(navigator.userAgent || "", "webinarlivDesktop" in window);
}

export function useInOwnApp(): boolean {
  return useSyncExternalStore(noSubscribe, readInOwnApp, () => false);
}

/** Whether this page may offer the apps: the Downloads page is switched on, and this is not
 *  one of our own apps already. */
export function useShowGetApp(): boolean {
  const visible = downloadsVisible(useAppConfig());
  return showGetAppLink({ visible, inOwnApp: useInOwnApp() });
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
  if (!useShowGetApp()) return null;
  return (
    <>
      {before}
      <Link href="/download" className={className} onClick={onClick}>
        {children}
      </Link>
    </>
  );
}

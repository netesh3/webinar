"use client";

import { useLayoutEffect } from "react";
import { syncSidebarClass } from "@/lib/sidebar";

/** Re-applies the rail class after hydration and when the window crosses 1280px.
 *  The head script already did this before first paint; this puts it back if
 *  hydration reset <html class>. */
export function SidebarBoot() {
  useLayoutEffect(() => {
    syncSidebarClass();
    const onResize = () => syncSidebarClass();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return null;
}

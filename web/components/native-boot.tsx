"use client";

/* The Android / iOS app's hooks into the page (apps/mobile; the logic is
 * lib/native-bridge.ts). Renders nothing, and does nothing outside the app:
 * in a browser window.Capacitor is undefined and both effects return at once. */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { startNativeBridge, syncKeepAwake } from "@/lib/native-bridge";

export function NativeBoot() {
  const pathname = usePathname();
  useEffect(() => startNativeBridge(), []);
  useEffect(() => syncKeepAwake(pathname ?? "/"), [pathname]);
  return null;
}

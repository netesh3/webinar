"use client";

/* The Android / iOS app's hooks into the page (apps/mobile; the logic is
 * lib/native-bridge.ts). Renders nothing, and does nothing outside the app:
 * in a browser window.Capacitor is undefined and both effects return at once. */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "@/components/providers";
import { setNativeSessionUser, startNativeBridge, syncKeepAwake } from "@/lib/native-bridge";

export function NativeBoot() {
  const pathname = usePathname();
  useEffect(() => startNativeBridge(), []);
  useEffect(() => syncKeepAwake(pathname ?? "/"), [pathname]);
  return null;
}

/* Tells the bridge who is signed in, so the install's push token goes to that account
 * (POST /api/push/native) after any kind of sign-in: password, email link, or the Google
 * hand-off. Inside <AppProviders>, where the session lives. (29 Oct 2026) */
export function NativeSessionSync() {
  const { account, status } = useSession();
  const id = account?.id ?? null;
  useEffect(() => {
    if (status === "loading") return;
    setNativeSessionUser(status === "signed-in" ? id : null);
  }, [id, status]);
  return null;
}

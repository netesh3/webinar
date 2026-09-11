"use client";

import {
  DEV_BYPASS_OFF_COOKIE,
  DEV_BYPASS_OFF_STORAGE_KEY,
  isDevAuthBypass,
} from "@/lib/dev-bypass-flag";

/** True when env bypass is on and this tab has not opted out via Sign out. */
export function isDevAuthBypassActive(): boolean {
  return isDevAuthBypass() && !isDevBypassOptedOut();
}

export function isDevBypassOptedOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(DEV_BYPASS_OFF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Opt out of the fake host session (Sign out under local bypass). */
export function setDevBypassOptedOut(off: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (off) {
      sessionStorage.setItem(DEV_BYPASS_OFF_STORAGE_KEY, "1");
      document.cookie = `${DEV_BYPASS_OFF_COOKIE}=1; Path=/; SameSite=Lax`;
    } else {
      sessionStorage.removeItem(DEV_BYPASS_OFF_STORAGE_KEY);
      document.cookie = `${DEV_BYPASS_OFF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    // Private mode / blocked storage — cookie alone still helps middleware.
    if (off) {
      document.cookie = `${DEV_BYPASS_OFF_COOKIE}=1; Path=/; SameSite=Lax`;
    } else {
      document.cookie = `${DEV_BYPASS_OFF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  }
}

/** Clear opt-out and hard-navigate into the preview host session. */
export function continueAsPreviewHost(dest = "/host"): void {
  setDevBypassOptedOut(false);
  window.location.assign(dest);
}

"use client";

import { useEffect } from "react";
import { FARO_URL, detachFaro } from "@/lib/observability";

/* Grafana Faro, started once the page has loaded and the browser is idle, so the SDK never
 * competes with first paint or hydration (lib/faro-init.ts is its own chunk). Builds without
 * NEXT_PUBLIC_FARO_URL never fetch it.
 *
 * Not on the recorder template: that is the egress's headless Chrome, whose CPU is the mix's,
 * and whose "sessions" are not people. */
export function FaroBoot() {
  useEffect(() => {
    if (!FARO_URL || window.location.pathname.includes("/recorder-template")) {
      detachFaro();
      return;
    }
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      import("@/lib/faro-init")
        .then((m) => m.startFaro(FARO_URL))
        .catch(() => detachFaro());
    };
    const idle = () => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, { timeout: 5000 });
      } else {
        window.setTimeout(start, 1000);
      }
    };
    if (document.readyState === "complete") {
      idle();
    } else {
      window.addEventListener("load", idle, { once: true });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("load", idle);
    };
  }, []);
  return null;
}

"use client";

/* The iOS app and Apple's in-app purchase rule (App Store guideline 3.1.1), as the page
 * sees it (29 Oct 2026).
 *
 * Host plans are digital subscriptions, so inside the iOS app they could only be sold
 * through Apple's In-App Purchase. The app does not sell them: every price, plan picker,
 * "Buy" and "Upgrade" control, and Razorpay checkout itself, is left out there. What is
 * shown instead is a neutral line with no link and no "buy on our website": Apple
 * treats pointing people to an outside purchase as steering (3.1.1 / 3.1.3), and the
 * reader-app link entitlement does not cover a product like this. Accounts are paid for
 * on the web; the app is for joining and hosting. Android and the desktop app keep
 * purchasing as on the web.
 *
 * Two layers, so nothing flashes before React runs: <html data-ios-app> is set by an
 * inline script in <head> (appStoreBootScript, lib/device.ts) and globals.css hides
 * .ios-app-hidden / shows .ios-app-only; useIOSApp is the same answer for logic (which
 * text to render, whether checkout may open). It is false on the server and in the first
 * client render, then the real value, like the other UA checks (register-form.tsx).
 */

import { useSyncExternalStore, type ReactNode } from "react";
import { currentIsIOSApp } from "@/lib/device";

/** The text in place of a plan change or purchase inside the iOS app. No link. */
export const IOS_APP_PLANS_NOTE = "Plan changes aren't available in the app.";

const noSubscribe = () => () => {};

/** True inside the iOS app (see lib/device.ts isIOSAppUA). */
export function useIOSApp(): boolean {
  return useSyncExternalStore(noSubscribe, currentIsIOSApp, () => false);
}

/** A whole page about prices (/pricing, /features, /pricing/proposed): in the iOS app
 *  only a heading and the neutral line. Before the page knows, both are rendered and CSS
 *  picks one, so the prices never paint there. */
export function IOSAppPlansGate({ children }: { children: ReactNode }) {
  const iosApp = useIOSApp();
  const note = (
    <section className="mx-auto w-full max-w-xl px-5 py-16 text-center">
      <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Plans</h1>
      <p className="mt-2 text-[14px] text-ink-2">{IOS_APP_PLANS_NOTE}</p>
    </section>
  );
  if (iosApp) return note;
  return (
    <>
      <div className="ios-app-only">{note}</div>
      <div className="ios-app-hidden">{children}</div>
    </>
  );
}

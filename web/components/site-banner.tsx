"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BANNER_DISMISS_KEY, bannerId, bannerVisible, type BannerState } from "@/lib/site-banner";
import { useSession } from "./providers";

/* The site-wide maintenance banner (api/internal/api/site_banner.go), across every page for
 * everyone but admins. A slim bar in the page flow at the very top, so it pushes content down
 * instead of covering a room's stage or controls. It reads the banner on load and once a minute
 * (a toggle in Admin reaches open pages within about a minute), and a dismissal lasts for this
 * browser session, for this banner only. */
const POLL_MS = 60_000;

export function SiteBanner() {
  const { account } = useSession();
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      api
        .siteBanner()
        .then((b) => {
          if (!alive) return;
          let d: string | null = null;
          try {
            d = window.sessionStorage.getItem(BANNER_DISMISS_KEY);
          } catch {
            /* storage off: the banner just cannot be dismissed */
          }
          setDismissed(d);
          setBanner(b);
        })
        .catch(() => {
          /* no banner is the safe answer */
        });
    read();
    const t = window.setInterval(read, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (!bannerVisible(banner, { isAdmin: Boolean(account?.isAdmin), dismissed })) return null;
  const b = banner as BannerState;

  return (
    <div
      role="status"
      className="relative z-50 flex items-start gap-3 bg-amber-300 px-4 py-2 text-[13px] font-medium leading-snug text-amber-950 sm:items-center"
    >
      <span aria-hidden className="material-symbols-outlined text-[18px] leading-none">
        construction
      </span>
      <p className="m-0 flex-1">{b.message}</p>
      <button
        type="button"
        onClick={() => {
          const id = bannerId(b);
          try {
            window.sessionStorage.setItem(BANNER_DISMISS_KEY, id);
          } catch {
            /* ignore */
          }
          setDismissed(id);
        }}
        className="rounded px-2 py-0.5 text-[12px] font-semibold underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-950"
        aria-label="Dismiss the maintenance notice"
      >
        Dismiss
      </button>
    </div>
  );
}

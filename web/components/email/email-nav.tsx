"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/* Sits beside the WhatsApp messages button. Email is its own screen, not a
 * webinar stage tab. */
export function EmailNavLink() {
  const pathname = usePathname();
  const here = pathname === "/host/email" || pathname.startsWith("/host/email/");
  return (
    <Link
      href="/host/email"
      aria-current={here ? "page" : undefined}
      className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium ${
        here ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      Email
    </Link>
  );
}

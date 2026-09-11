"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, PlusIcon, SettingsIcon } from "./icons";
import { useSession } from "./providers";

/* Host-portal nav.
 *
 * Only routes that exist. The previous version listed eight items and rendered
 * six of them as disabled rows to show "the shape of the product" — which reads
 * as a broken app rather than a roadmap, and gives a host nothing to click.
 */
const ITEMS = [
  { href: "/host", label: "Webinars", icon: CalendarIcon, exact: true, hosts: false },
  // Scheduling needs the hosting capability, so a guest speaker who is only here
  // to join a stage is not offered a form that ends in a 403.
  { href: "/host/new", label: "Schedule", icon: PlusIcon, exact: true, hosts: true },
  { href: "/account", label: "Account", icon: SettingsIcon, exact: true, hosts: false },
];

export function HostSidebar() {
  const pathname = usePathname();
  const { account } = useSession();
  const canHost = account?.canHost ?? false;

  return (
    // Hidden below md, where the top nav already carries these destinations —
    // a 188px column on a phone would leave 170px for the content.
    <aside className="hidden w-[176px] shrink-0 md:block">
      <nav className="sticky top-20 grid gap-0.5">
        {ITEMS.filter((item) => canHost || !item.hosts).map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${
                active
                  ? "bg-brand-soft font-medium text-brand"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

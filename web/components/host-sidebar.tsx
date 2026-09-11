"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, PlusIcon, SettingsIcon, UsersIcon } from "./icons";
import { useSession } from "./providers";
import { isDevAuthBypass } from "@/lib/dev-bypass";

/* Host-portal nav — only real destinations, short labels. */
const ITEMS = [
  { href: "/host", label: "Webinars", icon: CalendarIcon, exact: true, hosts: false },
  { href: "/host/new", label: "Create", icon: PlusIcon, exact: true, hosts: true },
  { href: "/account", label: "Account", icon: SettingsIcon, exact: true, hosts: false },
];

export function HostSidebar() {
  const pathname = usePathname();
  const { account } = useSession();
  const canHost = account?.canHost ?? false;
  const bypass = isDevAuthBypass();

  return (
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
        {bypass && (
          <Link
            href="/preview/room"
            className="mt-2 flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <UsersIcon className="size-4 shrink-0" />
            Room preview
          </Link>
        )}
      </nav>
    </aside>
  );
}

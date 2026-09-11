"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Menu } from "./controls";
import { CloseIcon, MenuIcon } from "./icons";
import { useAppConfig, useSession } from "./providers";
import { useRegistrations } from "./registrations";
import { Avatar, ButtonLink } from "./ui";
import { HostAlerts } from "./host-alerts";
import { setUiMode, useUiRedesign } from "@/lib/ui-redesign";

/* The top bar — primary product nav.
 *
 * Redesign: Browse | My webinars | Hosting.
 * Classic: Browse webinars (on `/`) | My webinars | Host.
 */

function linksFor(signedIn: boolean, canHost: boolean, redesign: boolean) {
  if (redesign) {
    return [
      { href: "/browse", label: "Browse" },
      ...(signedIn ? [{ href: "/my-webinars", label: "My webinars" }] : []),
      ...(canHost ? [{ href: "/host", label: "Hosting" }] : []),
    ];
  }
  return [
    { href: "/", label: "Browse webinars" },
    ...(signedIn ? [{ href: "/my-webinars", label: "My webinars" }] : []),
    ...(canHost ? [{ href: "/host", label: "Host" }] : []),
  ];
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { appName } = useAppConfig();
  const { account, status, signOut } = useSession();
  const { registrations } = useRegistrations();
  const redesign = useUiRedesign();
  const [open, setOpen] = useState(false);
  const links = linksFor(Boolean(account), account?.canHost === true, redesign);

  const count = registrations?.length ?? 0;

  const isActive = (href: string) => {
    if (href === "/browse") {
      return pathname === "/browse" || pathname.startsWith("/browse/");
    }
    if (href === "/") {
      return pathname === "/";
    }
    return pathname.startsWith(href);
  };

  const uiToggleItem = {
    kind: "action" as const,
    label: redesign ? "Use classic UI" : "Try new UI",
    onSelect: () => setUiMode(redesign ? "classic" : "new"),
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-5">
        <Link
          href="/"
          className="mr-1 flex shrink-0 items-center gap-2.5 sm:mr-3"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-brand text-[12px] font-bold text-white">
            {appName.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">
            {appName}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {links.map((l) => (
            <NavLink
              key={l.href}
              {...l}
              active={isActive(l.href)}
              badge={l.href === "/my-webinars" ? count : 0}
            />
          ))}
        </nav>

        <div className="flex-1" />

        {status === "loading" ? (
          <span className="size-7 animate-pulse rounded-full bg-surface-2" />
        ) : account ? (
          <>
            {account.canHost && <HostAlerts />}
            <Menu
              label="Your account"
              align="end"
              trigger={
                <span className="flex items-center gap-2 rounded-lg py-1 pr-1 pl-2 hover:bg-surface-2">
                  <span className="hidden max-w-32 truncate text-[12.5px] text-ink-2 md:block">
                    {account.name}
                  </span>
                  <Avatar
                    person={{
                      id: account.id,
                      name: account.name,
                      title: account.title,
                      org: account.org,
                      initials: account.initials,
                      hue: account.hue,
                    }}
                    size={28}
                  />
                </span>
              }
              items={[
                { kind: "label", text: account.email },
                ...(account.isAdmin
                  ? [
                      {
                        kind: "action" as const,
                        label: "Admin",
                        onSelect: () => router.push("/admin"),
                      },
                    ]
                  : []),
                {
                  kind: "action",
                  label: "Account settings",
                  onSelect: () => router.push("/account"),
                },
                uiToggleItem,
                { kind: "separator" },
                {
                  kind: "action",
                  label: "Sign out",
                  onSelect: async () => {
                    await signOut();
                    router.push("/");
                  },
                },
              ]}
            />
          </>
        ) : (
          <div className="hidden items-center gap-2 sm:flex">
            <button
              type="button"
              onClick={() => setUiMode(redesign ? "classic" : "new")}
              className="rounded-lg px-2 py-1 text-[12px] text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              {redesign ? "Classic UI" : "New UI"}
            </button>
            <ButtonLink href="/login" variant="ghost" size="sm">
              Sign in
            </ButtonLink>
            <ButtonLink href="/signup" size="sm">
              Create account
            </ButtonLink>
          </div>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 sm:hidden"
        >
          {open ? (
            <CloseIcon className="size-5" />
          ) : (
            <MenuIcon className="size-5" />
          )}
        </button>
      </div>

      {open && (
        <div className="border-t border-line px-4 pt-2 pb-3 sm:hidden">
          <nav className="grid gap-0.5">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(l.href) ? "page" : undefined}
                className={`flex h-9 items-center justify-between rounded-lg px-3 text-[14px] ${
                  isActive(l.href)
                    ? "bg-brand-soft font-medium text-brand"
                    : "text-ink-2 hover:bg-surface-2"
                }`}
              >
                {l.label}
                {l.href === "/my-webinars" && count > 0 && (
                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
                    {count}
                  </span>
                )}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => setUiMode(redesign ? "classic" : "new")}
              className="flex h-9 items-center rounded-lg px-3 text-left text-[14px] text-ink-2 hover:bg-surface-2"
            >
              {redesign ? "Use classic UI" : "Try new UI"}
            </button>
          </nav>

          {!account && status !== "loading" && (
            <div className="mt-2 grid gap-2 border-t border-line pt-3">
              <ButtonLink
                href="/login"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                Sign in
              </ButtonLink>
              <ButtonLink href="/signup" onClick={() => setOpen(false)}>
                Create account
              </ButtonLink>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

function NavLink({
  href,
  label,
  active,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  badge: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13.5px] transition-colors ${
        active
          ? "bg-brand-soft font-medium text-brand"
          : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {label}
      {badge > 0 && (
        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {badge}
        </span>
      )}
    </Link>
  );
}

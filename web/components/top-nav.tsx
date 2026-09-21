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

/* The top bar: the account menu, and one nav entry for whoever is not hosting.
 *
 * It held three. Browse went first: a public catalogue that stopped being one,
 * since the list is now scoped to sessions the account already hosts, presents
 * on or registered for. My Webinar went the same way and for the same reason —
 * it is the WatchList tab on Host Webinar now, sitting after Drafts with the
 * host's other lists. A nav entry per view of one person's sessions asks them to
 * decide which door leads to the webinar they are looking for, and both doors
 * open on the same room.
 *
 * Host Webinar went last, and for a sharper version of the same reason: a host
 * has no second door to choose between, only the one they are already standing
 * in. The link pointed at whatever page they were already reading — clicking it
 * could not have gone anywhere. The logo does that job now, see homeHrefFor.
 *
 * Both routes stay reachable. /browse still takes the links already sent out, and
 * /my-webinars is where registering sends somebody and what the account menu's
 * neighbours link to. */

function linksFor(signedIn: boolean, canHost: boolean) {
  // A host reaches their registrations through the tab, and /host through the
  // logo (see homeHrefFor) — nothing left for a nav entry to point at that is
  // not already the page they are standing on. An account that cannot host has
  // no Host Webinar page to hold that tab, so the entry survives for them —
  // otherwise this nav is empty and their own registrations are reachable only
  // by typing the URL. Same label as the tab, since it is the same list; the
  // /my-webinars path stays as it is, because renaming a URL breaks the links
  // already sent out to it.
  if (canHost) return [];
  return signedIn ? [{ href: "/my-webinars", label: "WatchList" }] : [];
}

/** Where the logo takes you. A host's real home base is /host — everything else
 *  reachable from here is either that page's own tabs or a room opened from
 *  inside it — so the logo is the way back to it now that the nav does not
 *  repeat it as a link. */
function homeHrefFor(canHost: boolean): string {
  return canHost ? "/host" : "/";
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { appName } = useAppConfig();
  const { account, status, signOut } = useSession();
  const { registrations } = useRegistrations();
  const [open, setOpen] = useState(false);
  const links = linksFor(Boolean(account), account?.canHost === true);
  // Nothing for the mobile drawer to reveal without at least one of these — a
  // button that opens onto an empty panel is worse than no button.
  const hasMobileMenu = links.length > 0 || !account;

  const count = registrations?.length ?? 0;

  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-5">
        <Link
          href={homeHrefFor(account?.canHost === true)}
          className="mr-1 flex shrink-0 items-center gap-2.5 sm:mr-3"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed
              brand asset, not a page image next/image would optimize. */}
          <img src="/brand/mark.png" alt="" width={28} height={28} className="size-7 rounded-lg" />
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">
            {appName}
          </span>
          {/* Sets expectations before anybody signs up, rather than after
              something surprises them. Deliberately quiet — a label, not a
              banner — so it reads as honest rather than as an apology. */}
          <span className="rounded-md border border-brand/25 bg-brand-soft px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.09em] text-brand uppercase">
            Beta
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
            <ButtonLink href="/login" variant="ghost" size="sm">
              Sign in
            </ButtonLink>
            <ButtonLink href="/signup" size="sm">
              Create account
            </ButtonLink>
          </div>
        )}

        {hasMobileMenu && (
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
        )}
      </div>

      {open && hasMobileMenu && (
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

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

/* The top bar.
 *
 * Below `sm` the links collapse into a disclosure panel rather than shrinking:
 * three nav items plus an account menu does not fit on a 360px screen, and a nav
 * that wraps to two rows pushes the page content below the fold.
 */

/* The nav, built from what this visitor can actually open.
 *
 * Previously a static list, so every visitor — including somebody who had just arrived on a
 * registration link — was shown Browse webinars, My webinars and Host. Two of those now
 * redirect for anyone who is not signed in or cannot host, and a link that bounces is worse
 * than no link.
 *
 * This is NOT the access control. `middleware.ts` refuses the routes and the API refuses the
 * requests; removing a link only stops the product advertising doors that are locked. The
 * participant experience does not render this component at all — see ParticipantHeader.
 */
function linksFor(signedIn: boolean, canHost: boolean) {
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
  const [open, setOpen] = useState(false);
  const links = linksFor(Boolean(account), account?.canHost === true);

  // Guest registrations live in this browser; an account's live on the account.
  // Either way the badge is "things you're signed up for".
  const count = registrations?.length ?? 0;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

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
            {/* The bell, only for accounts that can host. An attendee has no approval
                queue, so an empty bell would be a control that never does anything. */}
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
                {
                  kind: "action",
                  label: "My webinars",
                  onSelect: () => router.push("/my-webinars"),
                },
                /* No "Become a host" any more.
                 *
                 * It pointed at a toggle on /account that granted the capability on the
                 * spot, which is what made hosting self-service. Hosting is an admin grant
                 * now, so an entry inviting somebody to help themselves would lead to a
                 * read-only badge and a dead end. An account without it simply sees no host
                 * entry, which is honest. */
                ...(account.canHost
                  ? [
                      {
                        kind: "action" as const,
                        label: "Host portal",
                        onSelect: () => router.push("/host"),
                      },
                    ]
                  : []),
                /* The admin area, for the handful of accounts that can grant hosting.
                 *
                 * A hint, not the control: /api/admin/* refuses a non-admin regardless of
                 * what the browser chose to render, and lib/access.ts redirects the page. */
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

"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ENGAGE_HOME, MESSAGES_HREF, PEOPLE_HREF, useReplies } from "@/engage";
import { toggleSidebar } from "@/lib/sidebar";
import { AccountAvatar } from "./account-avatar";
import { Menu, type MenuItem } from "./controls";
import { HostAlerts } from "./host-alerts";
import { CalendarIcon, MenuIcon, SettingsIcon, UsersIcon } from "./icons";
import { useAppConfig, useSession } from "./providers";
import { useTheme } from "./theme";

/* The host shell from the approved sidebar mock.
 *
 * Webinars, Audience, WhatsApp, Settings, the theme switch and the account
 * sit here. Page bodies are unchanged — this only replaces the top bar on the
 * host portal and on Settings. A nav click never toggles the rail. */

function subscribeChrome(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const wide = window.matchMedia("(min-width: 1280px)");
  const phone = window.matchMedia("(max-width: 767px)");
  wide.addEventListener("change", onChange);
  phone.addEventListener("change", onChange);
  return () => {
    obs.disconnect();
    wide.removeEventListener("change", onChange);
    phone.removeEventListener("change", onChange);
  };
}

/** "rail|phone|drawer" — a string so the snapshot stays referentially stable. */
function readChrome(): string {
  const phone = window.matchMedia("(max-width: 767px)").matches;
  const drawer = document.body.classList.contains("nav-open");
  const rail = !phone && document.documentElement.classList.contains("side-collapsed");
  return `${rail ? 1 : 0}|${phone ? 1 : 0}|${drawer ? 1 : 0}`;
}

function useChrome() {
  const snap = useSyncExternalStore(subscribeChrome, readChrome, () => "0|0|0");
  const [rail, phone, drawer] = snap.split("|");
  return { rail: rail === "1", phone: phone === "1", drawer: drawer === "1" };
}

function closeDrawer() {
  document.body.classList.remove("nav-open");
}

export function AppShell({ children }: { children: ReactNode }) {
  const { appName } = useAppConfig();
  const { account } = useSession();
  const chrome = useChrome();
  const pathname = usePathname();
  const name = appName || "Webinar Liv";
  const home = account?.canHost ? "/host" : "/";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    closeDrawer();
  }, [pathname]);

  const chevronLabel = chrome.phone
    ? "Close menu"
    : chrome.rail
      ? "Expand sidebar"
      : "Collapse sidebar";

  return (
    <div className="app-shell">
      <header className="sb-mbar">
        <button
          type="button"
          className="sb-menu"
          aria-label="Open menu"
          aria-expanded={chrome.drawer}
          onClick={() => document.body.classList.add("nav-open")}
        >
          <MenuIcon className="size-5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed brand asset */}
        <img src="/brand/mark.png" alt="" width={28} height={28} className="sb-mark" />
        <strong>{name}</strong>
      </header>

      <aside className="sb-side" aria-label="Sidebar">
        <div className="sb-brand">
          <Link href={home} className="sb-logo" onClick={closeDrawer}>
            {/* eslint-disable-next-line @next/next/no-img-element -- fixed brand asset */}
            <img
              src="/brand/mark.png"
              alt=""
              width={28}
              height={28}
              className="sb-mark"
            />
            <span className="sb-brand-copy">
              <strong>{name}</strong>
              <span className="sb-beta">Beta</span>
            </span>
          </Link>
          <button
            type="button"
            className="sb-collapse"
            aria-label={chevronLabel}
            onClick={toggleSidebar}
          >
            <Chevron />
          </button>
        </div>

        <Suspense fallback={<PrimaryNav tab={null} />}>
          <PrimaryNavSearch />
        </Suspense>

        <Footer />
      </aside>
      <div className="sb-scrim" aria-hidden="true" onClick={closeDrawer} />

      <div className="sb-main">{children}</div>
    </div>
  );
}

function PrimaryNavSearch() {
  const tab = useSearchParams().get("tab");
  return <PrimaryNav tab={tab} />;
}

function PrimaryNav({ tab }: { tab: string | null }) {
  const pathname = usePathname();
  const replies = useReplies();
  const { account, status } = useSession();
  const unread = replies?.needsReply ?? 0;
  const connected =
    status === "loading" ? null : account?.whatsapp ? 1 : 0;
  const chrome = useChrome();
  const [open, setOpen] = useState(true);

  const onPeople = pathname === "/host" && tab === "people";
  const onWhatsApp =
    pathname === ENGAGE_HOME ||
    pathname.startsWith(`${ENGAGE_HOME}/`) ||
    pathname === MESSAGES_HREF ||
    pathname.startsWith(`${MESSAGES_HREF}/`);
  const onEmail = pathname === "/host/email" || pathname.startsWith("/host/email/");
  const onWebinars =
    !onPeople &&
    !onWhatsApp &&
    !onEmail &&
    pathname !== "/host/login" &&
    (pathname === "/host" || pathname.startsWith("/host/"));

  const whatsAppFly =
    unread > 0 ? (
      <>
        WhatsApp · <em>{unread === 1 ? "1 unread" : `${unread} unread`}</em>
      </>
    ) : (
      "WhatsApp"
    );

  return (
    <nav className="sb-nav" aria-label="Primary">
      <Item
        href="/host"
        label="Webinars"
        active={onWebinars}
        icon={<CalendarIcon />}
      />
      <Item
        href={PEOPLE_HREF}
        label="Audience"
        active={onPeople}
        icon={<UsersIcon />}
      />
      <button
        type="button"
        className="sb-int-h"
        aria-expanded={open}
        aria-controls="int-tree"
        tabIndex={chrome.rail ? -1 : 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sb-chev" aria-hidden="true">
          <ChevronDown />
        </span>
        <span className="sb-lbl">Integrations</span>
        {connected !== null && (
          <span className="sb-cnt">
            {connected === 1 ? "1 connected" : `${connected} connected`}
          </span>
        )}
      </button>
      <div className={open ? "sb-tree-wrap" : "sb-tree-wrap shut"} id="int-tree">
        <div className="sb-tree">
          <div className="sb-tree-in">
            <Item
              href={ENGAGE_HOME}
              label="WhatsApp"
              active={onWhatsApp}
              icon={<WhatsAppGlyph />}
              badge={unread > 0 ? (unread > 99 ? "99+" : String(unread)) : undefined}
              fly={whatsAppFly}
            />
            <Item href="/host/email" label="Email" active={onEmail} icon={<MailGlyph />} />
            <Link href="/settings#integrations" className="sb-int-add" onClick={closeDrawer}>
              + Add integration
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}

function Item({
  href,
  label,
  active,
  icon,
  badge,
  fly,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: ReactNode;
  badge?: string;
  fly?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={active ? "sb-navitem on" : "sb-navitem"}
      aria-current={active ? "page" : undefined}
      onClick={closeDrawer}
    >
      <span className="sb-ic">{icon}</span>
      <span className="sb-lbl">{label}</span>
      {badge && <span className="sb-badge">{badge}</span>}
      <span className="sb-fly">{fly ?? label}</span>
    </Link>
  );
}

function Footer() {
  const pathname = usePathname();
  const router = useRouter();
  const { account, status, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");

  const items: MenuItem[] = account
    ? [
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
          label: "Settings",
          onSelect: () => router.push("/settings"),
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
      ]
    : [];

  return (
    <div className="sb-foot">
      <nav className="sb-nav" aria-label="Settings">
        <Item
          href="/settings"
          label="Settings"
          active={onSettings}
          icon={<SettingsIcon />}
        />
      </nav>
      <button
        type="button"
        className="sb-navitem sb-theme"
        onClick={toggle}
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      >
        <span className="sb-ic sb-moon">
          <Moon />
        </span>
        <span className="sb-ic sb-sun">
          <Sun />
        </span>
        <span className="sb-lbl">{dark ? "Light" : "Dark"}</span>
        <span className="sb-fly">{dark ? "Light mode" : "Dark mode"}</span>
      </button>
      {account?.canHost && <HostAlerts placement="side" />}
      {status === "loading" ? (
        <div className="sb-account" aria-hidden>
          <span className="size-8 animate-pulse rounded-full bg-surface-2" />
        </div>
      ) : account ? (
        <Menu
          label="Your account"
          align="start"
          side="top"
          wrapClassName="w-full"
          className="sb-account"
          trigger={
            <>
              <AccountAvatar
                initials={account.initials}
                hue={account.hue}
                photo={account.avatarUrl}
                size={32}
              />
              <span className="sb-who">
                <span className="sb-nm">{account.name}</span>
                <span className="sb-em">{account.email}</span>
              </span>
              <span className="sb-fly">{account.name}</span>
            </>
          }
          items={items}
        />
      ) : (
        <div className="sb-signin">
          <Link href="/login" className="sb-navitem" onClick={closeDrawer}>
            <span className="sb-lbl">Sign in</span>
            <span className="sb-fly">Sign in</span>
          </Link>
          <Link href="/signup" className="sb-navitem" onClick={closeDrawer}>
            <span className="sb-lbl">Create account</span>
            <span className="sb-fly">Create account</span>
          </Link>
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 3.5 5.5 8 10 12.5" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.5 6 7.5l3-3" />
    </svg>
  );
}

function MailGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </svg>
  );
}

/** Empty speech bubble from the sidebar mock — not the green WhatsApp mark. */
function WhatsAppGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 16.5 4.5 20.5V7.2A2.2 2.2 0 0 1 6.7 5h10.6A2.2 2.2 0 0 1 19.5 7.2v7.1a2.2 2.2 0 0 1-2.2 2.2H6z" />
    </svg>
  );
}

function Moon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z" />
    </svg>
  );
}

function Sun() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </svg>
  );
}

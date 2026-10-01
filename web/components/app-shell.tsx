"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ENGAGE_HOME, MESSAGES_HREF, PEOPLE_HREF, useReplies } from "@/engage";
import { toggleSidebar } from "@/lib/sidebar";
import type { ThemeChoice } from "@/lib/theme";
import { AccountAvatar } from "./account-avatar";
import { HostAlerts } from "./host-alerts";
import { CalendarIcon, MenuIcon, SettingsIcon, UsersIcon } from "./icons";
import { useAppConfig, useSession } from "./providers";
import { useTheme } from "./theme";

/* The host shell.
 *
 * The brand stays pinned at the top of the sidebar and links home — it is not
 * a menu. Webinars, Audience and Integrations stay in the rail. Settings, the
 * theme switch and notifications used to be footer rows; they now sit at the
 * top-right of the main column, on every page this shell wraps. The bell is
 * the existing notification panel. The avatar opens account, theme and
 * sign-out. A nav click never toggles the rail. */

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

        <PrimaryNav />
      </aside>
      <div className="sb-scrim" aria-hidden="true" onClick={closeDrawer} />

      <div className="sb-main">
        <Chrome />
        {children}
      </div>
    </div>
  );
}

function PrimaryNav() {
  const pathname = usePathname();
  const replies = useReplies();
  const { account, status } = useSession();
  const unread = replies?.needsReply ?? 0;
  const connected =
    status === "loading" ? null : account?.whatsapp ? 1 : 0;
  const chrome = useChrome();
  const [open, setOpen] = useState(true);

  const onPeople =
    pathname === "/host/audience" || pathname.startsWith("/host/audience/");
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
        data-tour="nav-integrations"
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
      {account?.isAdmin && (
        <Item
          href="/admin"
          label="Admin"
          active={pathname === "/admin" || pathname.startsWith("/admin/")}
          icon={<AdminGlyph className="" />}
        />
      )}
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
      data-tour={`nav-${label.toLowerCase()}`}
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

/** Bell and avatar, top-right of the main column. The menu floats over the
 *  page; it is not a row in the sidebar. */
function Chrome() {
  const { account, status } = useSession();

  return (
    <div className="sb-chrome">
      {account?.canHost && <HostAlerts />}
      {status === "loading" ? (
        <span className="size-9 animate-pulse rounded-full bg-surface-2" aria-hidden />
      ) : account ? (
        <AccountMenu />
      ) : (
        <div className="flex items-center gap-1">
          <Link
            href="/login"
            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            Create account
          </Link>
        </div>
      )}
    </div>
  );
}

const THEME_OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function AccountMenu() {
  const router = useRouter();
  const { account, signOut } = useSession();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  if (!account) return null;

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Your account"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <AccountAvatar
          initials={account.initials}
          hue={account.hue}
          photo={account.avatarUrl}
          size={36}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Account"
          /* Wide enough for Settings plus the Light/Dark control. The kebab
           * menus stay on Menu's shrink-to-label width; this panel is not
           * that component. */
          className="absolute top-full right-0 z-[70] mt-2 w-[17.75rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-xl"
        >
          <button
            type="button"
            onClick={() => {
              close();
              router.push("/settings");
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] font-medium text-ink hover:bg-surface-2"
          >
            <SettingsIcon className="size-4 text-ink-2" />
            Settings
          </button>
          {account.isAdmin && (
            <button
              type="button"
              onClick={() => {
                close();
                router.push("/admin");
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] font-medium text-ink hover:bg-surface-2"
            >
              <span className="grid size-4 place-items-center text-ink-2" aria-hidden>
                <AdminGlyph />
              </span>
              Admin
            </button>
          )}

          <div className="my-1 h-px bg-line" role="separator" />
          <div className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
            Preferences
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-[13px] font-medium text-ink">Theme</span>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="flex shrink-0 rounded-lg bg-surface-2 p-0.5"
            >
              {THEME_OPTIONS.map((option) => {
                const on = theme === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setTheme(option.id)}
                    className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      on
                        ? "bg-surface text-ink shadow-sm"
                        : "text-ink-3 hover:text-ink"
                    }`}
                  >
                    {option.id === "light" ? <Sun /> : <Moon />}
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="my-1 h-px bg-line" role="separator" />
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <AccountAvatar
              initials={account.initials}
              hue={account.hue}
              photo={account.avatarUrl}
              size={36}
            />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-ink">
                {account.name}
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-ink-3">
                {account.email}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              void signOut().then(() => router.push("/"));
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13.5px] font-medium text-ink hover:bg-surface-2"
          >
            <SignOutGlyph />
            Sign out
          </button>
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

function AdminGlyph({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3 5 6v5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3z" />
    </svg>
  );
}

function SignOutGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 text-ink-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v9A1.5 1.5 0 0 0 6.5 18H9" />
      <path d="M10 12h9" />
      <path d="m15.5 8.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

function Moon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5"
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
      className="size-3.5"
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

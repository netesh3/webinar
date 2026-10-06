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
import { ApiError, api } from "@/lib/api";
import {
  IntegrationActionNavigate,
  IntegrationStatusConnected,
  type IntegrationCard,
} from "@/lib/api-types";
import { appHome } from "@/lib/access";
import { noteAttendeeVisit } from "@/lib/host-welcome";
import { toggleSidebar } from "@/lib/sidebar";
import { AccountAvatar } from "./account-avatar";
import { HostAlerts } from "./host-alerts";
import { BookmarkIcon, CalendarIcon, MaterialIcon, MenuIcon, SettingsIcon, UsersIcon, WhatsAppIcon } from "./icons";
import { useAppConfig, useSession } from "./providers";
import { useRegistrations } from "./registrations";
import { useTheme } from "./theme";

/* The host shell.
 *
 * The brand stays pinned at the top of the sidebar and links home — it is not
 * a menu. Webinars, Audience and Integrations stay in the rail. Settings and
 * a one-click light/dark button are pinned to the bottom of that same pane,
 * with the nav above and empty space between. The bell stays at the top-right
 * of the main column. The avatar opens Admin (for admins), the account and
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
  const home = account ? appHome(account.canHost) : "/";

  useEffect(() => {
    if (account && !account.canHost) noteAttendeeVisit();
  }, [account]);

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
        <SidebarFooter />
      </aside>
      <div className="sb-scrim" aria-hidden="true" onClick={closeDrawer} />

      <div className="sb-main">
        <Chrome />
        {children}
      </div>
    </div>
  );
}

/** Pages the sidebar already opens. Anything else connected goes to Settings. */
const HOST_INTEGRATION: Record<string, { href: string; label: string }> = {
  whatsapp: { href: ENGAGE_HOME, label: "WhatsApp" },
  email: { href: "/host/email", label: "Email" },
};

type SidebarIntegration = {
  id: string;
  href: string;
  label: string;
  icon: ReactNode;
};

/* Settings cards have one section anchor, #integrations, and no per-card id.
 * A connected app with no host page lands there. A card with neither an icon
 * (mark or text) nor any destination is left out of the list. */
function knownIcon(id: string): ReactNode | null {
  if (id === "whatsapp") return <WhatsAppIcon />;
  if (id === "email") return <MailGlyph />;
  if (id === "zoom") return <ZoomGlyph />;
  if (id === "youtube") return <YouTubeGlyph />;
  return null;
}

function sidebarIntegration(card: IntegrationCard): SidebarIntegration | null {
  const known = HOST_INTEGRATION[card.id];
  const icon = knownIcon(card.id) ?? integrationIcon(card);
  const href = known?.href ?? hostPage(card) ?? (icon ? "/settings#integrations" : null);
  if (!href || !icon) return null;
  return { id: card.id, href, label: known?.label ?? card.name, icon };
}

function hostPage(card: IntegrationCard): string | null {
  for (const action of card.actions ?? []) {
    if (action.kind !== IntegrationActionNavigate || !action.href?.startsWith("/host")) continue;
    return action.href;
  }
  return null;
}

/* Brand color on the glyph, for a connected row that has no drawn logo. */
const MARK_COLOR: Record<string, string> = {
  wa: "text-[#25D366]",
  yt: "text-[#FF0000]",
  li: "text-[#0A66C2]",
  tg: "text-[#2AA3DF]",
  gc: "text-[#1A73E8]",
  ig: "text-[#DD2A7B]",
  mc: "text-[#C89600]",
  zp: "text-[#FF4F00]",
  zm: "text-[#2D8CFF]",
  mail: "text-[#7B8CA0]",
};

function integrationIcon(card: IntegrationCard): ReactNode | null {
  const color = MARK_COLOR[card.tone] ?? "text-ink-2";
  if (card.mark) {
    return <MaterialIcon name={card.mark} fill className={`size-[18px] ${color}`} />;
  }
  if (card.text) return <span className={`sb-int-mark ${color}`}>{card.text}</span>;
  return null;
}

function integrationActive(
  row: SidebarIntegration,
  pathname: string,
  onWhatsApp: boolean,
  onEmail: boolean,
): boolean {
  if (row.id === "whatsapp") return onWhatsApp;
  if (row.id === "email") return onEmail;
  if (row.href.startsWith("/settings")) return false;
  const path = row.href.split("?")[0] ?? row.href;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function connectedName(label: string, badge?: string): string {
  return badge ? `${label}, Connected, ${badge} unread` : `${label}, Connected`;
}

function PrimaryNav() {
  const { account, status } = useSession();
  /* Loading paints neither set. The host items appearing for an attendee,
   * even for one frame, is a door that does not open. */
  if (status === "loading") return <nav className="sb-nav" aria-hidden="true" />;
  if (account && !account.canHost) return <AttendeeNav />;
  return <HostPrimaryNav />;
}

/** WatchList is the only place an attendee has. Audience and Integrations
 *  are host tools; showing them leads to a page that says hosting is off. */
function AttendeeNav() {
  const pathname = usePathname();
  const { account } = useSession();
  const { registrations } = useRegistrations();
  const count = registrations?.length ?? 0;

  return (
    <nav className="sb-nav" aria-label="Primary">
      <Item
        href="/my-webinars"
        label="WatchList"
        active={pathname === "/my-webinars"}
        icon={<BookmarkIcon />}
        badge={count > 0 ? String(count) : undefined}
      />
      {/* An admin need not be a host. The rest of the host nav stays hidden. */}
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

function HostPrimaryNav() {
  const pathname = usePathname();
  const replies = useReplies();
  const { account, status } = useSession();
  const unread = replies?.needsReply ?? 0;
  const chrome = useChrome();
  const [open, setOpen] = useState(true);
  const [slot, setSlot] = useState<{ id: string; cards: IntegrationCard[] } | null>(null);

  /* Same list Settings uses for the Connected badge and the "N on" count:
   * GET /api/host/integrations, status === "connected". Session cache, so a
   * settings reload is what the sidebar reads next. */
  useEffect(() => {
    if (status !== "signed-in" || !account) return;
    const id = account.id;
    let cancelled = false;
    api
      .hostIntegrations()
      .then((res) => {
        if (!cancelled) setSlot({ id, cards: res.integrations ?? [] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setSlot(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [status, account]);

  const cards =
    status === "signed-in" && account && slot?.id === account.id ? slot.cards : null;
  const rows = (cards ?? []).flatMap((card) => {
    if (card.status !== IntegrationStatusConnected) return [];
    const row = sidebarIntegration(card);
    return row ? [row] : [];
  });
  const connected = cards === null ? null : rows.length;

  const onPeople =
    pathname === "/host/audience" || pathname.startsWith("/host/audience/");
  const onWhatsApp =
    pathname === ENGAGE_HOME ||
    pathname.startsWith(`${ENGAGE_HOME}/`) ||
    pathname === MESSAGES_HREF ||
    pathname.startsWith(`${MESSAGES_HREF}/`);
  const onEmail = pathname === "/host/email" || pathname.startsWith("/host/email/");
  const onListedHost = rows.some((row) => {
    if (row.id === "whatsapp" || row.id === "email" || row.href.startsWith("/settings")) return false;
    const path = row.href.split("?")[0] ?? row.href;
    return pathname === path || pathname.startsWith(`${path}/`);
  });
  const onWebinars =
    !onPeople &&
    !onWhatsApp &&
    !onEmail &&
    !onListedHost &&
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
            {rows.map((row) => {
              const badge =
                row.id === "whatsapp" && unread > 0
                  ? unread > 99
                    ? "99+"
                    : String(unread)
                  : undefined;
              return (
                <Item
                  key={row.id}
                  href={row.href}
                  label={row.label}
                  active={integrationActive(row, pathname, onWhatsApp, onEmail)}
                  icon={row.icon}
                  live
                  badge={badge}
                  fly={row.id === "whatsapp" ? whatsAppFly : undefined}
                  ariaLabel={connectedName(row.label, badge)}
                />
              );
            })}
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
  ariaLabel,
  live,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: ReactNode;
  badge?: string;
  fly?: ReactNode;
  /** Kept when the visible label is hidden on the collapsed rail. */
  ariaLabel?: string;
  /** Green live dot. The row name includes "Connected" so it is not color-only. */
  live?: boolean;
}) {
  return (
    <Link
      href={href}
      data-tour={`nav-${label.toLowerCase()}`}
      className={active ? "sb-navitem on" : "sb-navitem"}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      onClick={closeDrawer}
    >
      <span className="sb-ic">
        {icon}
        {live && (
          <span className="sb-live" title="Connected">
            <span className="sr-only">Connected</span>
          </span>
        )}
      </span>
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

/** Settings, then the one-click theme button, pinned under the nav. */
function SidebarFooter() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const themeLabel = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <div className="sb-foot">
      <Item
        href="/settings"
        label="Settings"
        active={onSettings}
        icon={<SettingsIcon />}
        ariaLabel="Settings"
      />
      <button
        type="button"
        className="sb-navitem sb-theme"
        onClick={() => setTheme(dark ? "light" : "dark")}
        aria-label={themeLabel}
      >
        <span className="sb-ic sb-moon">
          <Moon />
        </span>
        <span className="sb-ic sb-sun">
          <Sun />
        </span>
        <span className="sb-fly">{themeLabel}</span>
      </button>
    </div>
  );
}

export function AccountMenu() {
  const router = useRouter();
  const { account, signOut } = useSession();
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
          className="absolute top-full right-0 z-[70] mt-2 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-xl"
        >
          {account.isAdmin && (
            <>
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
              <div className="my-1 h-px bg-line" role="separator" />
            </>
          )}
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

/** Filled video camera on Zoom blue. A simple mark, not the Zoom artwork. */
function ZoomGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect width="24" height="24" rx="6" fill="#2D8CFF" />
      <rect x="5" y="8.3" width="10" height="7.4" rx="1.4" fill="#fff" />
      <path fill="#fff" d="M14.2 10.2 18.8 8.3v7.4l-4.6-1.9V10.2z" />
    </svg>
  );
}

/** Filled envelope in a soft gray-blue, so the row stays a mail mark. */
function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="2.8" y="5.6" width="18.4" height="12.8" rx="2.2" fill="#7B8CA0" />
      <path
        d="M4.2 7.6 12 13.1 19.8 7.6"
        fill="none"
        stroke="#F7F9FB"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Red tile and a white play. A simple mark, not the YouTube artwork. */
function YouTubeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect width="24" height="24" rx="6" fill="#FF0000" />
      <path fill="#fff" d="M10 8v8l7-4-7-4z" />
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

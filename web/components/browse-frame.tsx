"use client";

import Link from "next/link";
import { AccountMenu } from "./app-shell";
import { BrowseScreen } from "./browse-screen";
import { HostPortalFrame } from "./host-portal-frame";
import { ParticipantHeader } from "./participant-header";
import { useAppConfig, useSession } from "./providers";

/* /browse is not a public catalogue. The list is the sessions this account
 * hosts, presents, or registered for, and an anonymous caller is turned away.
 *
 * A signed-in host already lives in the sidebar shell everywhere else, so this
 * page uses that same shell. Everyone else gets the public header the webinar
 * page uses — logo, no product nav. A signed-in attendee still needs the way
 * to their registrations and the account menu; those are the controls they
 * already had, not a new section of the app. */

const column = "mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5";

export function BrowseFrame() {
  const { account, status } = useSession();
  const host = status === "signed-in" && account?.canHost === true;
  const screen = <BrowseScreen />;

  if (host) return <HostPortalFrame>{screen}</HostPortalFrame>;

  return (
    <>
      {status !== "loading" && <BrowsePublicHeader />}
      <main className={column}>{screen}</main>
    </>
  );
}

/** Logo row from the public webinar page, plus WatchList and the account
 *  menu once an attendee is signed in. Anonymous visitors get the logo only,
 *  the same as a registration page. */
function BrowsePublicHeader() {
  const { account, status } = useSession();
  const attendee = status === "signed-in" && account && !account.canHost;

  if (!attendee) return <ParticipantHeader />;

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-5">
        <BrandHome />
        <div className="flex-1" />
        <Link
          href="/my-webinars"
          className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          WatchList
        </Link>
        <AccountMenu />
      </div>
    </header>
  );
}

function BrandHome() {
  const { appName } = useAppConfig();

  return (
    <Link href="/" className="flex min-w-0 items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed
          brand asset, not a page image next/image would optimize. */}
      <img
        src="/brand/mark.png"
        alt=""
        width={28}
        height={28}
        className="size-7 rounded-lg"
      />
      <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">
        {appName}
      </span>
    </Link>
  );
}

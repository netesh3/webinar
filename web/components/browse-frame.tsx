"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { BrowseScreen } from "./browse-screen";
import { HostPortalFrame } from "./host-portal-frame";
import { ParticipantHeader } from "./participant-header";
import { useSession } from "./providers";

/* /browse is not a public catalogue. The list is the sessions this account
 * hosts, presents, or registered for.
 *
 * A signed-in host already lives in the sidebar shell everywhere else, so this
 * page uses that same shell. Someone signed out gets the public header the
 * webinar page uses. An attendee does not stay here: WatchList is their home,
 * and middleware sends them. The effect covers a visit middleware let through
 * because the session could not be checked in time. */

const column = "mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5";

export function BrowseFrame() {
  const { account, status } = useSession();
  const router = useRouter();
  const host = status === "signed-in" && account?.canHost === true;
  const attendee = status === "signed-in" && Boolean(account) && !account?.canHost;
  const screen = <BrowseScreen />;

  useEffect(() => {
    if (attendee) router.replace("/my-webinars");
  }, [attendee, router]);

  if (host) return <HostPortalFrame>{screen}</HostPortalFrame>;
  if (attendee) return null;

  return (
    <>
      {status !== "loading" && <ParticipantHeader />}
      <main className={column}>{screen}</main>
    </>
  );
}

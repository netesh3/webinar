"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HostRequest } from "./host-request";
import { MyWebinarsList } from "./my-webinars-list";
import { useSession } from "./providers";

/* An attendee's home, inside the same side panel a host uses.
 *
 * Hosts never stay here. /my-webinars sends them to the Attending tab
 * before the page runs; the effect covers a visit middleware let through
 * because the session could not be checked in time. */
export function WatchListScreen() {
  const { account, status } = useSession();
  const router = useRouter();
  const host = account?.canHost === true;

  useEffect(() => {
    if (host) router.replace("/host?tab=attending");
  }, [host, router]);

  if (host) return null;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">WatchList</h1>
        <p className="mt-1.5 text-[14px] text-ink-2">
          Everything you&apos;ve registered for, with your personal join key.
        </p>
      </div>
      {status === "signed-in" && account && (
        <HostRequest account={account} placement="home" />
      )}
      <MyWebinarsList />
    </>
  );
}

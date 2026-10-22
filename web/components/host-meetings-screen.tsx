"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HostWebinarBrowser } from "./host-webinar-browser";
import { ActionCardBody, actionCardClass, instantStartError } from "./host-webinars-screen";
import { Spinner } from "./controls";
import { CalendarIcon, UsersIcon } from "./icons";
import { useSession, useShareOrigin, useToast } from "./providers";
import { ButtonLink, Card } from "./ui";
import { api } from "@/lib/api";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { localTimeZone } from "@/lib/format";
import { meetingsOffered } from "@/lib/host-features";
import { instantMeetingInput } from "@/lib/meeting-create";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";

/** Host Meetings: start or schedule a meeting, and the host's own meetings — Upcoming
 *  (including live) and Completed — read from the same paged list as Webinars, narrowed
 *  to kind=meeting by the server so the counts and pages are the meetings' own. */
export function HostMeetingsScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const router = useRouter();
  const bypass = isDevAuthBypassActive();
  const [starting, setStarting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const canHost = account?.canHost ?? false;

  /* Not a host: /host knows what to show them (a panelist's stage list, or WatchList). */
  useEffect(() => {
    if (status === "signed-in" && !canHost) router.replace("/host");
  }, [status, canHost, router]);

  /* "Start a meeting": the instant webinar's flow with a meeting's request. Not behind the
   * instant-webinar switch — the server does not gate an instant meeting either, because
   * "meet now" is the ordinary way a meeting begins. The invite link goes to the clipboard
   * because the people to invite are elsewhere. */
  async function startMeeting() {
    if (bypass) {
      openRoomTab("/preview/room");
      return;
    }
    const pendingTab = openPendingRoomTab();
    setStarting(true);
    try {
      const created = await api.createWebinar(instantMeetingInput(localTimeZone()));
      await api.startWebinar(created.id);
      pendingTab.open(`/host/${created.id}/room`);
      try {
        await navigator.clipboard.writeText(`${origin}/webinars/${created.id}`);
        notify("Meeting started — invite link copied.", "ok");
      } catch {
        notify("Meeting started. Open Share from the room to copy the invite link.", "info");
      }
      setReloadToken((n) => n + 1);
    } catch (err) {
      pendingTab.cancel();
      notify(
        instantStartError(err).replace("Could not start the webinar.", "Could not start the meeting."),
        "error",
      );
    } finally {
      setStarting(false);
    }
  }

  if (status === "loading" || (status === "signed-in" && !canHost)) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Sign in to host</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Hosting a meeting needs an account. The people you invite need only the link.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/login?next=/host/meetings">Sign in</ButtonLink>
          <ButtonLink href="/signup?host=1" variant="secondary">
            Create an account
          </ButtonLink>
        </div>
      </Card>
    );
  }

  return (
    <>
      <h1 className="sr-only">Your meetings</h1>
      {/* Meetings switched off for this account (Admin -> Accounts): the server refuses a new
       * one, so neither card is offered. Meetings already held stay listed below. */}
      {!meetingsOffered(account) ? (
        <Card className="mb-6 p-5">
          <h2 className="text-[15px] font-semibold">Meetings aren&apos;t switched on for this account</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            Ask us to turn on meetings to start or schedule one.
          </p>
        </Card>
      ) : (
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={startMeeting}
          disabled={starting}
          aria-busy={starting}
          className={actionCardClass}
        >
          <ActionCardBody
            icon={starting ? <Spinner className="size-4" /> : <UsersIcon className="size-4" />}
            title={starting ? "Starting…" : "Start a meeting"}
            subtitle="Everyone on camera; you let people in"
          />
        </button>
        <Link href="/host/new/meeting" className={actionCardClass}>
          <ActionCardBody
            icon={<CalendarIcon className="size-4" />}
            title="Schedule a meeting"
            subtitle="Pick a time and share the link"
          />
        </Link>
      </div>
      )}

      <HostWebinarBrowser kind="meeting" reloadToken={reloadToken} />
    </>
  );
}

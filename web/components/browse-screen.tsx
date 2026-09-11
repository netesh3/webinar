"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import {
  DEV_BYPASS_WEBINARS,
  isDevAuthBypass,
} from "@/lib/dev-bypass";
import { BrowseList } from "./browse-list";
import { useSession } from "./providers";
import { Button, ButtonLink, Empty } from "./ui";

/* Post-login home: for hosts, a simple task hub; for everyone else, their sessions. */

export function BrowseScreen() {
  const { account, status } = useSession();
  const bypass = isDevAuthBypass();
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [state, setState] = useState<
    "loading" | "ok" | "signed-out" | "unreachable"
  >("loading");

  const load = useCallback(() => {
    if (bypass) {
      setWebinars(DEV_BYPASS_WEBINARS.filter((w) => w.status !== "draft"));
      setState("ok");
      return;
    }
    api
      .listWebinars()
      .then((rows) => {
        setWebinars(rows);
        setState("ok");
      })
      .catch((err: unknown) => {
        setState(
          err instanceof ApiError && err.status === 401
            ? "signed-out"
            : "unreachable",
        );
      });
  }, [bypass]);

  useEffect(() => {
    if (status === "loading") return;
    load();
  }, [status, load]);

  const signedOut = state === "signed-out" || (state !== "loading" && !account);
  const canHost = account?.canHost === true;

  const upcomingHost = useMemo(
    () =>
      (webinars ?? []).filter(
        (w) =>
          w.host.id === account?.id &&
          (w.status === "scheduled" || w.status === "live"),
      ),
    [webinars, account?.id],
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] sm:text-[26px]">
            {signedOut
              ? "Webinars"
              : canHost
                ? "Home"
                : "Your webinars"}
          </h1>
          <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-ink-2">
            {signedOut
              ? "Sign in to see sessions you're hosting, presenting at, or registered for."
              : canHost
                ? "Create a webinar, host it when it's time, admit people who need approval, then review attendance."
                : "Sessions you're presenting at or registered for. Join from here when one starts."}
          </p>
        </div>
        {canHost && !signedOut && (
          <ButtonLink href="/host/new" className="shrink-0">
            Create webinar
          </ButtonLink>
        )}
      </div>

      {canHost && !signedOut && state === "ok" && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          <HubCard
            title="Host portal"
            body={
              upcomingHost.length > 0
                ? `${upcomingHost.length} upcoming — Host, Admit, or view Past attendance.`
                : "Schedule sessions, start the room, and manage registrants."
            }
            href="/host"
            cta="Open host"
          />
          <HubCard
            title="Room chrome preview"
            body="Docked side panel, control bar, and stage layout without LiveKit."
            href="/preview/room"
            cta="Open room UI"
            show={bypass}
          />
          {!bypass && (
            <HubCard
              title="My registrations"
              body="Sessions you registered for as an attendee."
              href="/my-webinars"
              cta="My webinars"
            />
          )}
        </div>
      )}

      {state === "loading" ? (
        <div className="grid gap-3">
          <div className="h-28 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-28 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ) : state === "unreachable" ? (
        <Empty
          title="Can't reach the API"
          hint="The server isn't responding. Try again in a moment."
          action={<Button onClick={load}>Try again</Button>}
        />
      ) : signedOut ? (
        <Empty
          title="Sign in to see your webinars"
          hint="This list is private — it only ever shows sessions you're involved in."
          action={<ButtonLink href="/login">Sign in</ButtonLink>}
        />
      ) : (webinars?.length ?? 0) === 0 ? (
        <Empty
          title={canHost ? "Nothing scheduled yet" : "Nothing here yet"}
          hint={
            canHost
              ? "Create a webinar to get Host, Admit, and attendance in one place."
              : "Webinars you host, present at, or register for will appear here."
          }
          action={
            canHost ? (
              <ButtonLink href="/host/new">Create webinar</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          {canHost && (
            <h2 className="mb-3 text-[13px] font-semibold text-ink-2">
              Your sessions
            </h2>
          )}
          <BrowseList
            webinars={webinars ?? []}
            tracks={[...new Set((webinars ?? []).map((w) => w.track))]
              .filter(Boolean)
              .sort()}
          />
        </>
      )}
    </>
  );
}

function HubCard({
  title,
  body,
  href,
  cta,
  show = true,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
  show?: boolean;
}) {
  if (!show) return null;
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-4">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{body}</p>
      <ButtonLink href={href} variant="secondary" size="sm" className="mt-3">
        {cta}
      </ButtonLink>
    </div>
  );
}

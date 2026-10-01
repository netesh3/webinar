"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { BrowseList } from "./browse-list";
import { HostRequest } from "./host-request";
import { useSession } from "./providers";
import { Button, ButtonLink, Empty } from "./ui";

/* Browse — sessions you're involved in.
 *
 * Signed out, there is nothing to list: the API only answers for an account.
 * Hosting work (create / start / admit / past) lives on the host home, not as
 * a second dashboard here. Keep this page a single list.
 */

export function BrowseScreen() {
  const { account, status } = useSession();
  const bypass = isDevAuthBypassActive();
  const [fetchedWebinars, setWebinars] = useState<Webinar[] | null>(null);
  const [fetchState, setState] = useState<
    "loading" | "ok" | "signed-out" | "unreachable"
  >("loading");

  const load = useCallback(() => {
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
  }, []);

  // The catalogue only needs the session cookie, which this request sends on its
  // own. It starts with the login check rather than after it. Local preview has
  // nothing to fetch: the fixture list is derived below.
  useEffect(() => {
    if (bypass) return;
    load();
  }, [bypass, load]);

  const webinars = bypass
    ? DEV_BYPASS_WEBINARS.filter((w) => w.status !== "draft")
    : fetchedWebinars;
  const state = bypass ? (status === "loading" ? "loading" : "ok") : fetchState;

  const signedOut =
    state === "signed-out" || (status === "anonymous" && state !== "loading");
  const canHost = account?.canHost === true;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            {signedOut ? "Webinars" : "Browse"}
          </h1>
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-ink-2">
            {signedOut
              ? "Sign in to see sessions you're hosting, presenting at, or registered for."
              : canHost
                ? "Sessions you're involved in. Create, start, and admit from Hosting."
                : "Sessions you're presenting at or registered for. Join from here when one starts."}
          </p>
        </div>
        {canHost && !signedOut && (
          <ButtonLink href="/host" variant="secondary" className="shrink-0">
            Open Hosting
          </ButtonLink>
        )}
      </div>

      {account && !signedOut && !canHost && (
        <HostRequest account={account} placement="home" />
      )}

      {bypass && !signedOut && (
        <p className="mb-6 text-[13px] text-ink-3">
          Local preview — room chrome at{" "}
          <a
            className="underline hover:text-ink"
            href="/preview/room"
            target="_blank"
            rel="noopener noreferrer"
          >
            /preview/room
          </a>
          .
        </p>
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
              ? "Create a webinar in Hosting to get started."
              : "Webinars you host, present at, or register for will appear here."
          }
          action={
            canHost ? (
              <ButtonLink href="/host/new">Create webinar</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <BrowseList
          webinars={webinars ?? []}
          tracks={[...new Set((webinars ?? []).map((w) => w.track))]
            .filter(Boolean)
            .sort()}
        />
      )}
    </>
  );
}

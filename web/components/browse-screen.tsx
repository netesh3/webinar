"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import {
  DEV_BYPASS_WEBINARS,
  isDevAuthBypass,
} from "@/lib/dev-bypass";
import { BrowseList } from "./browse-list";
import { useSession } from "./providers";
import { Button, ButtonLink, Empty } from "./ui";

/* Browse — sessions you're involved in (or the public catalogue when signed out).
 *
 * Hosting work (create / start / admit / past) lives under Hosting in the top
 * nav, not as a second dashboard here. Keep this page a single list.
 */

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

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] sm:text-[26px]">
            {signedOut ? "Webinars" : "Browse"}
          </h1>
          <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-ink-2">
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

      {bypass && !signedOut && (
        <p className="mb-6 text-[13px] text-ink-3">
          Local preview — room chrome at{" "}
          <a className="underline hover:text-ink" href="/preview/room">
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

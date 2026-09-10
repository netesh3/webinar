"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { BrowseList } from "./browse-list";
import { useSession } from "./providers";
import { Button, ButtonLink, Empty } from "./ui";

/* The front page, client-rendered — and it has to be.
 *
 * This was a Server Component that called listWebinars() during render. That worked while the
 * list was a public catalogue and broke the moment it required a session, in a way that looked
 * like a login bug rather than a data-fetching one: a signed-in host saw the nav correctly
 * showing their account, the bell, "My webinars", and underneath it "Sign in to see your
 * webinars".
 *
 * The reason is that the session is an httpOnly cookie held by the BROWSER. A Server Component's
 * fetch runs in Node with no cookie jar, so `credentials: "include"` has nothing to include and
 * the API answers 401 every time — for everybody, signed in or not.
 *
 * Forwarding the cookie from next/headers would also work. Client rendering is the better answer
 * here because the page is no longer public: there is nothing left to server-render for a search
 * engine or a first-paint benefit, and /host and /my-webinars are already client-rendered for
 * exactly this reason. One rule for authenticated pages is worth more than a marginal render.
 */

export function BrowseScreen() {
  const { account, status } = useSession();
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [state, setState] = useState<
    "loading" | "ok" | "signed-out" | "unreachable"
  >("loading");

  /* Not an async function: the writes happen in .then().
   *
   * react-hooks/set-state-in-effect rejects an async call from an effect body because it
   * cannot see that everything after the first await is a later tick. Same shape as
   * useDevices in lib/media.ts. */
  const load = useCallback(() => {
    api
      .listWebinars()
      .then((rows) => {
        setWebinars(rows);
        setState("ok");
      })
      .catch((err: unknown) => {
        // 401 is the expected answer for a visitor with no session, not a failure.
        setState(
          err instanceof ApiError && err.status === 401
            ? "signed-out"
            : "unreachable",
        );
      });
  }, []);

  useEffect(() => {
    /* Wait for the session to resolve before asking.
     *
     * Firing immediately would race: on a signed-in browser the request can land before the
     * session provider has finished, and a 401 would flash the "sign in" screen at somebody who
     * is already signed in — the exact confusion this component exists to fix. */
    if (status === "loading") return;
    load();
  }, [status, load]);

  const signedOut = state === "signed-out" || (state !== "loading" && !account);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em] sm:text-[26px]">
          {signedOut ? "Webinars" : "Your webinars"}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
          {signedOut
            ? "Sign in to see the sessions you're hosting, presenting at, or registered for. Have an invitation link? Open it directly — you don't need an account to register."
            : "Sessions you're hosting, presenting at, or registered for. Join straight from here when one starts."}
        </p>
      </div>

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
          title="Nothing here yet"
          hint="Webinars you host, present at, or register for will appear here."
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

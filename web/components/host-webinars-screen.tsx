"use client";

import { useCallback, useEffect, useState } from "react";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { useSession } from "./providers";
import { ButtonLink, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";

/** The host portal's home: everything this account owns, plus the sessions it is
 *  booked to appear on as a panelist. */
export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const [mine, setMine] = useState<Webinar[] | null>(null);
  const [onStage, setOnStage] = useState<Webinar[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canHost = account?.canHost ?? false;

  const load = useCallback(() => {
    // The stage list is loaded for every signed-in account, hosting or not. Being
    // invited to speak on somebody else's webinar is a different thing from
    // running your own, and for a guest speaker this list is the only way into the
    // room they were invited to.
    api
      .stageWebinars()
      .then(setOnStage)
      .catch(() => setOnStage([]));

    // `mine` stays null for an account that cannot host: the branch that reads it
    // is unreachable for them, and setting it here would be a synchronous state
    // change inside the effect that calls this.
    if (!canHost) return;
    api
      .hostWebinars()
      .then((owned) => {
        setMine(owned);
        setError(null);
      })
      .catch((e: unknown) => {
        setMine([]);
        if (e instanceof ApiError && e.code === "not_a_host") return; // handled below
        setError(
          e instanceof Error ? e.message : "Could not load your webinars.",
        );
      });
  }, [canHost]);

  useEffect(() => {
    if (status === "signed-in") load();
  }, [status, load]);

  if (status === "loading") {
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
          Hosting needs an account <em>and</em> access granted by an
          administrator. Attendees need neither — their registration link is all
          they need.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/login?next=/host">Sign in</ButtonLink>
          <ButtonLink href="/signup?host=1" variant="secondary">
            Create an account
          </ButtonLink>
        </div>
      </Card>
    );
  }

  // Signed in, but this account has never asked to host. Hosting is a capability
  // checked server-side on every write, so it is turned on here rather than
  // assumed.
  if (!canHost) {
    return (
      <>
        {/* Shown first, because somebody who came here from an invitation is
            looking for a room to join, not for a capability to turn on. */}
        {onStage.length > 0 && (
          <section className="mb-8">
            <h1 className="mb-1.5 text-[24px] font-semibold tracking-[-0.02em]">
              You&apos;re a panelist on
            </h1>
            <p className="mb-3 text-[13.5px] text-ink-2">
              You can join the stage and present. Hosting your own webinars is a
              separate thing, and it&apos;s below if you want it.
            </p>
            <HostWebinarList webinars={onStage} readOnly />
          </section>
        )}
        {/* Hosting is a GRANT, so this is a message rather than a button.
         *
         * It used to be a "Become a host" button calling updateProfile({wantsHost:true}),
         * which is precisely the self-service promotion that had to stop — a public form
         * that handed out the ability to create webinars and collect strangers' names,
         * emails and phone numbers. The server ignores that field now, so leaving the
         * button in place meant a spinner that ran and changed nothing: worse than no
         * button, because it looks broken rather than restricted. */}
        <Card className="p-8 text-center">
          <h1 className="text-[18px] font-semibold">
            Hosting isn&apos;t enabled for this account
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-2">
            Only an administrator can turn it on. Ask whoever runs this instance
            to grant you hosting access — you keep the same account, and nothing
            you&apos;ve registered for is affected.
          </p>
          <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-ink-3">
            You can still register for and attend any session you have a link
            to.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <ButtonLink href="/my-webinars" variant="secondary" size="sm">
              My webinars
            </ButtonLink>
            <ButtonLink href="/account" variant="ghost" size="sm">
              Account settings
            </ButtonLink>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            Webinars
          </h1>
          <p className="mt-1.5 text-[13.5px] text-ink-2">
            Signed in as {account?.name}
            {account?.org ? ` · ${account.org}` : ""}
          </p>
        </div>
        <ButtonLink href="/host/new">Schedule a webinar</ButtonLink>
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {mine === null ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ) : mine.length === 0 && !error ? (
        <Empty
          title="Nothing scheduled"
          hint="Schedule your first webinar and share the registration page."
          action={<ButtonLink href="/host/new">Schedule a webinar</ButtonLink>}
        />
      ) : (
        <HostWebinarList webinars={mine} />
      )}

      {onStage.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[13px] font-semibold text-ink">
            You&apos;re a panelist on
          </h2>
          <HostWebinarList webinars={onStage} readOnly />
        </section>
      )}
    </>
  );
}

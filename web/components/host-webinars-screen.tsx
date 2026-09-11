"use client";

import { useCallback, useEffect, useState } from "react";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { useSession } from "./providers";
import { ButtonLink, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS, isDevAuthBypass } from "@/lib/dev-bypass";

/** Host home: create, run upcoming sessions, review past attendance.
 *
 *  One job per section — primary CTA to create, then the webinar list split into
 *  Upcoming / Past / Drafts. Deliberately not a metrics dashboard. */
export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const [mine, setMine] = useState<Webinar[] | null>(null);
  const [onStage, setOnStage] = useState<Webinar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bypass = isDevAuthBypass();

  const canHost = account?.canHost ?? false;

  const load = useCallback(() => {
    if (bypass) {
      setMine(DEV_BYPASS_WEBINARS);
      setOnStage([]);
      setError(null);
      return;
    }

    api
      .stageWebinars()
      .then(setOnStage)
      .catch(() => setOnStage([]));

    if (!canHost) return;
    api
      .hostWebinars()
      .then((owned) => {
        setMine(owned);
        setError(null);
      })
      .catch((e: unknown) => {
        setMine([]);
        if (e instanceof ApiError && e.code === "not_a_host") return;
        setError(
          e instanceof Error ? e.message : "Could not load your webinars.",
        );
      });
  }, [canHost, bypass]);

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

  if (!canHost) {
    return (
      <>
        {onStage.length > 0 && (
          <section className="mb-8">
            <h1 className="mb-1.5 text-[24px] font-semibold tracking-[-0.02em]">
              You&apos;re a panelist on
            </h1>
            <p className="mb-3 text-[13.5px] text-ink-2">
              Join the stage when the host starts. Hosting your own sessions is
              separate — ask an admin to enable it on your account.
            </p>
            <HostWebinarList webinars={onStage} readOnly />
          </section>
        )}
        <Card className="p-8 text-center">
          <h1 className="text-[18px] font-semibold">
            Hosting isn&apos;t enabled for this account
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-2">
            Only an administrator can turn it on. You can still register for and
            attend any session you have a link to.
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

  const upcoming =
    mine?.filter((w) => w.status === "scheduled" || w.status === "live")
      .length ?? 0;
  const pendingAdmit =
    mine?.find((w) => w.approval === "manual" && w.status !== "ended") ?? null;

  return (
    <>
      {bypass && (
        <div className="mb-4">
          <Alert tone="info" title="Local UI preview">
            Auth bypass is on — fixture webinars below. Room media is mocked at{" "}
            <a className="underline" href="/preview/room">
              /preview/room
            </a>
            .
          </Alert>
        </div>
      )}

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            Host
          </h1>
          <p className="mt-1.5 max-w-lg text-[13.5px] leading-relaxed text-ink-2">
            Create a session, start it when you&apos;re ready, admit people who
            need approval, then review who attended.
          </p>
        </div>
        <ButtonLink href="/host/new" className="shrink-0">
          Create webinar
        </ButtonLink>
      </div>

      {/* Three clear jobs — not a metrics strip. */}
      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <TaskHint
          title="Create"
          body="Schedule a new webinar and share the registration link."
          href="/host/new"
          cta="New webinar"
        />
        <TaskHint
          title="Host"
          body={
            upcoming > 0
              ? `${upcoming} upcoming — open one and press Host when live.`
              : "Nothing scheduled yet. Create one to get a Host button."
          }
          href={upcoming > 0 ? undefined : "/host/new"}
          cta={upcoming > 0 ? undefined : "Create first"}
        />
        <TaskHint
          title="Admit"
          body={
            pendingAdmit
              ? `Manual approval on “${pendingAdmit.topic}”. Open Manage → Admit.`
              : "Only needed when a webinar uses manual approval."
          }
          href={pendingAdmit ? `/host/${pendingAdmit.id}?tab=admit` : undefined}
          cta={pendingAdmit ? "Review queue" : undefined}
        />
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
          title="No webinars yet"
          hint="Create one, share the link, then Host when it's time."
          action={<ButtonLink href="/host/new">Create webinar</ButtonLink>}
        />
      ) : (
        <HostWebinarList webinars={mine} />
      )}

      {onStage.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 text-[15px] font-semibold">On stage as panelist</h2>
          <p className="mb-3 text-[13px] text-ink-2">
            Sessions you were invited to present on — join when the host starts.
          </p>
          <HostWebinarList webinars={onStage} readOnly />
        </section>
      )}
    </>
  );
}

function TaskHint({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href?: string;
  cta?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
        {title}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{body}</p>
      {href && cta && (
        <ButtonLink href={href} variant="ghost" size="sm" className="mt-2 -ml-2">
          {cta}
        </ButtonLink>
      )}
    </div>
  );
}

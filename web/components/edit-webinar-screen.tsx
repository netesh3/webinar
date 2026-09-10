"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ScheduleForm } from "./schedule-form";
import { Alert, Spinner } from "./controls";
import { ArrowLeftIcon } from "./icons";
import { ButtonLink, Card } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";

/** Loads a webinar the caller hosts and hands it to the schedule form.
 *
 *  Read through the host endpoint rather than the public one: a draft is not
 *  publicly visible, and a draft is exactly what a host comes here to finish. */
export function EditWebinarScreen({ slug }: { slug: string }) {
  const [webinar, setWebinar] = useState<Webinar | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    api
      .hostWebinar(slug)
      .then((w) => {
        if (active) setWebinar(w);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "unknown", message: "Could not load that webinar." },
        );
      });
    return () => {
      active = false;
    };
  }, [slug]);

  if (error) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[17px] font-semibold">
          {error.code === "unauthenticated" ? "Please sign in" : "Couldn't load that"}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          {error.message}
        </p>
        <ButtonLink
          href={
            error.code === "unauthenticated"
              ? `/login?next=/host/${slug}/edit`
              : "/host"
          }
          className="mt-5"
        >
          {error.code === "unauthenticated" ? "Sign in" : "Back to webinars"}
        </ButtonLink>
      </Card>
    );
  }

  if (!webinar) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  return (
    <>
      <Link
        href={`/host/${slug}`}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to the webinar
      </Link>
      <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.02em] sm:text-[24px]">
        Edit webinar
      </h1>
      <p className="mb-6 text-[13.5px] text-ink-2">{webinar.topic}</p>

      {webinar.status === "live" && (
        <div className="mb-4">
          <Alert tone="warn" title="This webinar is running">
            Changes to the session controls apply immediately to everyone in the
            room. Changing the date or time will not move anyone out of it.
          </Alert>
        </div>
      )}

      <ScheduleForm webinar={webinar} />
    </>
  );
}

import type { ReactNode } from "react";
import { Button, ButtonLink, Card } from "@/components/ui";
import { ApiError } from "@/lib/http";
import { Icon } from "./primitives";

/* Loading, error and empty states for the Engagement page. */

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Sign in again to see engagement.";
    if (error.status === 403) return "Only the host of this webinar can see its engagement.";
    if (error.status === 404) return "We couldn't find engagement for this webinar.";
    if (error.status === 0) return "Could not reach the server. Check your connection and try again.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong loading engagement.";
}

export function needsSignIn(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.code === "not_a_host");
}

export function ErrorState({
  error,
  onRetry,
  compact = false,
  signInHref,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
  signInHref?: string;
}) {
  const signIn = signInHref && needsSignIn(error);
  return (
    <div
      role="alert"
      className={`rounded-xl border border-live/25 bg-live-soft text-center ${compact ? "px-4 py-3 text-[12.5px]" : "px-6 py-12"}`}
    >
      {!compact && <p className="text-[15px] font-semibold text-ink">Couldn&apos;t load engagement</p>}
      <p className={`${compact ? "" : "mx-auto mt-1.5 max-w-md text-[13px]"} text-ink-2`}>{errorMessage(error)}</p>
      {(onRetry || signIn) && (
        <div className={`${compact ? "mt-2" : "mt-5"} flex justify-center gap-2`}>
          {signIn ? (
            <ButtonLink href={signInHref} size="sm">
              Sign in
            </ButtonLink>
          ) : (
            onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY: Record<string, { icon: string; title: string; hint: string }> = {
  not_started: {
    icon: "hourglass_empty",
    title: "Nothing to show yet — the webinar hasn't started",
    hint: "Once you go live, this tab fills in by itself and refreshes every 30 seconds. After the webinar it becomes your full report: who came, who stayed, and who to follow up with.",
  },
  no_audience: {
    icon: "person_off",
    title: "No one joined this webinar",
    hint: "Share the replay with your registrants so they can still catch up.",
  },
};

export function EmptyState({
  state,
  backHref,
  detail,
  action,
}: {
  state: string;
  backHref?: string;
  /** One more line under the hint, e.g. when the webinar is scheduled to start. */
  detail?: string;
  action?: ReactNode;
}) {
  const e = EMPTY[state] ?? EMPTY.not_started;
  return (
    <div className="rounded-xl border border-dashed border-line-2 bg-surface px-6 py-14 text-center sm:py-16">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-surface-2">
        <Icon name={e.icon} className="!text-[24px] text-ink-3" />
      </span>
      <p className="mt-3 text-[15px] font-semibold text-ink">{e.title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-2">{e.hint}</p>
      {detail && <p className="mt-2 text-[12.5px] font-medium text-ink">{detail}</p>}
      {(action || backHref) && (
        <div className="mt-5 flex justify-center gap-2">
          {action}
          {backHref && (
            <ButtonLink href={backHref} variant="secondary" size="sm">
              Back to the webinar
            </ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}

function Bone({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div className="grid gap-4 sm:gap-5" aria-busy="true" aria-label="Loading engagement">
      <Card className="grid gap-3 p-6 md:grid-cols-[minmax(0,1fr)_200px]">
        <div className="space-y-3">
          <Bone className="h-4 w-48" />
          <Bone className="h-7 w-3/4" />
          <Bone className="h-4 w-2/3" />
          <div className="grid gap-2 sm:grid-cols-3">
            <Bone className="h-12" />
            <Bone className="h-12" />
            <Bone className="h-12" />
          </div>
        </div>
        <Bone className="h-28" />
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Card key={i} className="space-y-2 p-3.5">
            <Bone className="h-3 w-20" />
            <Bone className="h-6 w-14" />
          </Card>
        ))}
      </div>
      <Card className="p-5">
        <Bone className="h-48" />
      </Card>
    </div>
  );
}

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { Person, Webinar } from "@/lib/api-types";

/* Small presentational primitives shared across every screen.
   Server Components — no state, no handlers. */

export function Avatar({
  person,
  size = 32,
}: {
  person: Person;
  size?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        background: person.hue,
        width: size,
        height: size,
        fontSize: size * 0.37,
      }}
      aria-hidden
    >
      {person.initials}
    </span>
  );
}

type Tone = "neutral" | "brand" | "ok" | "warn" | "live";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  brand: "bg-brand-soft text-brand border-brand-line",
  ok: "bg-ok-soft text-ok border-ok/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  live: "bg-live-soft text-live border-live/25",
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ${toneClass[tone]}`}
    >
      {dot && (
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      )}
      {children}
    </span>
  );
}

/** One label:value pair, used down the side of webinar detail pages. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 py-2.5">
      <dt className="w-28 shrink-0 text-[12.5px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13.5px]">{children}</dd>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(19,22,25,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-[13px] font-semibold tracking-[0.01em] text-ink">
      {children}
    </h2>
  );
}

/* A top-line number, the kind a dashboard leads with.
 *
 * The value is the number and the note is the only sentence, so a tile never
 * has to be read twice to find the figure. Tone colours the figure alone:
 * a red tile around a zero would look like an alarm about a quiet instance. */
export function Stat({
  label,
  value,
  note,
  tone = "neutral",
  className = "",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "brand" | "ok" | "warn" | "live";
  className?: string;
}) {
  const valueTone = {
    neutral: "text-ink",
    brand: "text-brand",
    ok: "text-ok",
    warn: "text-warn",
    live: "text-live",
  }[tone];
  return (
    <Card className={`p-4 ${className}`}>
      <div className="text-[12px] text-ink-2">{label}</div>
      <div
        className={`mt-1.5 text-[22px] font-semibold tracking-[-0.02em] tabular-nums ${valueTone}`}
      >
        {value}
      </div>
      {note && <div className="mt-0.5 text-[11.5px] text-ink-3">{note}</div>}
    </Card>
  );
}

/** Empty state, used by browse-with-no-matches and each host tab. */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-2 bg-surface px-6 py-14 text-center">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-lg text-[13.5px] font-medium whitespace-nowrap transition-colors " +
  // A visible keyboard ring on every button, since the room is operated under
  // time pressure and half of it is reachable only by tabbing.
  "outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1 " +
  "disabled:opacity-50 disabled:pointer-events-none";

const btnVariant = {
  primary: "bg-brand text-on-brand hover:bg-brand-hover",
  secondary: "border border-line-2 bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "border border-live/30 bg-surface text-live hover:bg-live-soft",
  /** For the one irreversible action on a screen — "End for all". */
  destructive: "bg-live text-on-live hover:bg-live/90",
} as const;

const btnSize = {
  sm: "h-8 px-3 text-[12.5px]",
  md: "h-10 px-4",
  lg: "h-11 px-5 text-[14px]",
} as const;

type ButtonVariant = keyof typeof btnVariant;
type ButtonSize = keyof typeof btnSize;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={`${btnBase} ${btnVariant[variant]} ${btnSize[size]} ${className}`}
      {...rest}
    />
  );
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <Link
      className={`${btnBase} ${btnVariant[variant]} ${btnSize[size]} ${className}`}
      {...rest}
    />
  );
}

/** The coloured strip at the top of a webinar card / detail hero.
 *
 *  Both stops come from the people on the webinar. With no panelist, the second
 *  stop is mixed from the host's own colour rather than a fixed accent, so the
 *  bar stays on-brand for whatever palette an operator's accounts end up with. */
export function TopicStripe({ webinar }: { webinar: Webinar }) {
  const from = webinar.host.hue;
  const to =
    webinar.panelists[0]?.hue ?? `color-mix(in oklab, ${from} 62%, white)`;
  return (
    <div
      className="h-1.5 w-full"
      style={{ background: `linear-gradient(90deg, ${from}, ${to})` }}
      aria-hidden
    />
  );
}

/** Previous / Page N of M / Next, under a list. Next replaces the rows. */
export function ListPager({
  page,
  pages,
  pageSize,
  start,
  end,
  total,
  onPrevious,
  onNext,
  busy = false,
  layout = "center",
  range = "stack",
  className = "",
}: {
  /** 1-based. */
  page: number;
  pages: number;
  pageSize: number;
  /** 1-based first row, or 0 when this page is empty. */
  start: number;
  end: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  busy?: boolean;
  /** Webinar lists sit in the middle. Tables and the inbox stretch across the card. */
  layout?: "center" | "split";
  /** A second line under the page label, or the same line after a dot. */
  range?: "stack" | "inline";
  className?: string;
}) {
  const empty = start <= 0 || end < start;
  const span = empty
    ? `${pageSize} per page · 0 on this page`
    : `${pageSize} per page · ${start}–${end} of ${total}`;
  return (
    <div
      className={
        layout === "split"
          ? `flex items-center justify-between gap-3 ${className}`
          : `mt-4 flex items-center justify-center gap-3.5 ${className}`
      }
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={onPrevious}
        disabled={busy || page <= 1}
      >
        Previous
      </Button>
      <div
        className={`text-[12.5px] leading-snug text-ink-2 ${range === "stack" ? "text-center" : ""}`}
      >
        <b className="font-semibold text-ink">
          Page {page} of {pages}
        </b>
        {range === "stack" ? (
          <div className="text-[11.5px] text-ink-3">{span}</div>
        ) : (
          <span className="text-[11.5px] text-ink-3"> · {span}</span>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={onNext}
        disabled={busy || page >= pages}
      >
        Next
      </Button>
    </div>
  );
}

export function kindLabel(w: Webinar): { text: string; tone: Tone } {
  if (w.status === "live") return { text: "Live now", tone: "live" };
  if (w.status === "ended") return { text: "Completed", tone: "neutral" };
  if (w.status === "draft") return { text: "Draft", tone: "warn" };
  if (w.kind === "recurring") return { text: "Series", tone: "brand" };
  // A scheduled broadcast is NOT "live" — reserve that word (and the red dot)
  // for a session actually in progress, or people think they're missing it.
  return { text: "Live webinar", tone: "neutral" };
}

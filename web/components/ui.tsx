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
  primary: "bg-brand text-white hover:bg-brand-hover",
  secondary: "border border-line-2 bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "border border-live/30 bg-surface text-live hover:bg-live-soft",
  /** For the one irreversible action on a screen — "End for all". */
  destructive: "bg-live text-white hover:bg-live/90",
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

export function kindLabel(w: Webinar): { text: string; tone: Tone } {
  if (w.status === "live") return { text: "Live now", tone: "live" };
  if (w.status === "ended") return { text: "Ended", tone: "neutral" };
  if (w.status === "draft") return { text: "Draft", tone: "warn" };
  if (w.kind === "simulive") return { text: "Simulive", tone: "brand" };
  if (w.kind === "recurring") return { text: "Series", tone: "brand" };
  // A scheduled broadcast is NOT "live" — reserve that word (and the red dot)
  // for a session actually in progress, or people think they're missing it.
  return { text: "Live webinar", tone: "neutral" };
}

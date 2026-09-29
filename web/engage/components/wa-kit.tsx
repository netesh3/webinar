"use client";

import type { ReactNode } from "react";
import { hueFor, initialsOf } from "@/lib/avatar";
import type { CRMTemplate } from "@/lib/api-types";

/* Engage v2's small shared pieces: the avatar every list shows, WhatsApp's ticks, the
 * phone frame the send preview sits in, and template names a coach can read.
 * See docs/engage/V2.md. */

/** WhatsApp's own outgoing-bubble green, and the header teal of its chat screen. */
export const WA_BUBBLE = "#d9fdd3";
export const WA_HEADER = "#075e54";
export const WA_WALL = "#efeae2";
export const WA_SEND = "#1a9c4b";

/** A round avatar with initials and a colour stable per person (the same seed and rule
 *  as the server's HueFor). The seed is the contact id when there is one, so two
 *  people called Priya are two colours. */
export function PersonAvatar({
  name,
  seed,
  size = 32,
}: {
  name: string;
  seed?: string;
  size?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        background: hueFor(seed || name || "?"),
        width: size,
        height: size,
        fontSize: Math.round(size * 0.37),
      }}
      aria-hidden
    >
      {initialsOf(name || "?")}
    </span>
  );
}

/** A row of overlapping avatars, "+N" past the limit. */
export function AvatarStack({
  people,
  max = 4,
  size = 22,
}: {
  people: { name: string; seed?: string }[];
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <span
          key={(p.seed || p.name) + i}
          className="rounded-full ring-2 ring-surface"
          style={{ marginLeft: i === 0 ? 0 : -6 }}
        >
          <PersonAvatar name={p.name} seed={p.seed} size={size} />
        </span>
      ))}
      {more > 0 && (
        <span className="ml-1 text-[11px] font-medium text-ink-3">+{more}</span>
      )}
    </span>
  );
}

/** WhatsApp's delivery ticks: one grey for sent, two grey for delivered, two blue for
 *  read. Queued shows a clock, failed a red "!". */
export function Ticks({ status }: { status: string }) {
  if (status === "failed")
    return (
      <span className="font-semibold text-live" aria-label="Failed">
        !
      </span>
    );
  if (status === "queued")
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3 text-ink-3"
        aria-label="Queued"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M8 5v3.5l2 1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  const two = status === "delivered" || status === "read";
  const color = status === "read" ? "#53bdeb" : "currentColor";
  return (
    <svg
      viewBox="0 0 18 12"
      className="h-2.5 w-3.5 text-ink-3"
      aria-label={status === "read" ? "Read" : two ? "Delivered" : "Sent"}
    >
      <path
        d="M1 6.5l3 3L10.5 2"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {two && (
        <path
          d="M6.5 9.5l.5.5L14.5 2"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A phone with a WhatsApp chat on it, for previews. */
export function PhoneFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[17rem] rounded-[2rem] border-[7px] border-[#1c1c1e] bg-[#1c1c1e] shadow-lg">
      <div className="overflow-hidden rounded-[1.5rem]">
        <div
          className="flex items-center gap-2 px-3 py-2.5 text-white"
          style={{ background: WA_HEADER }}
        >
          <PersonAvatar name={title} size={26} />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold">{title}</div>
            {subtitle && (
              <div className="truncate text-[10.5px] opacity-80">
                {subtitle}
              </div>
            )}
          </div>
        </div>
        <div
          className="grid min-h-64 content-start gap-2 px-2.5 py-3"
          style={{ background: WA_WALL }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A template name as a coach would say it: `missed_you_v2` is "Missed you". */
export function friendlyTemplateName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/\bv\d+\b/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  const s = words.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Meta's category as a pill: marketing is what Meta charges most for and what needs
 *  the opt-in, so it is the one worth colouring. */
export function CategoryPill({ category }: { category: string }) {
  const c = category.toUpperCase();
  const tone =
    c === "MARKETING"
      ? "bg-warn-soft text-warn"
      : c === "UTILITY"
        ? "bg-ok-soft text-ok"
        : "bg-surface-2 text-ink-2";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tone}`}
    >
      {c || "OTHER"}
    </span>
  );
}

/* Meta's per-message rates for India, in rupees, when this was written — close enough
 * for "about ₹14" and labelled an estimate wherever it is shown; Meta's rate card is
 * the real number and changes by country. Replies inside the 24-hour window are free. */
const RATE_INR: Record<string, number> = {
  MARKETING: 0.78,
  UTILITY: 0.12,
  AUTHENTICATION: 0.12,
};

export function estimateCost(counts: {
  marketing: number;
  utility: number;
}): number {
  return (
    counts.marketing * RATE_INR.MARKETING + counts.utility * RATE_INR.UTILITY
  );
}

export function templateRate(t: CRMTemplate): number {
  return RATE_INR[t.category.toUpperCase()] ?? 0;
}

export function rupees(n: number): string {
  if (n === 0) return "₹0";
  if (n < 10) return `₹${n.toFixed(2)}`;
  return `₹${Math.round(n)}`;
}

/** "82%" or "–" when there is nothing to divide by. */
export function pct(part: number, whole: number): string {
  if (!whole) return "–";
  return `${Math.round((part / whole) * 100)}%`;
}

/** A compact on/off switch with its label for screen readers only — for a card whose
 *  title already says what it switches. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[18px] w-[32px] shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-ok" : "bg-line-2"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-[14px]" : ""
        }`}
      />
    </button>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { hueFor, initialsOf } from "@/lib/avatar";

/* A person's face in the room: their photo when there is one, their initials on
 * a stable colour when there is not.
 *
 * Kept out of ui.tsx because that file is server components only, and the photo
 * fallback needs state: an <img> that fails to load (expired, blocked, deleted)
 * has to hand back to the initials rather than leave a broken-image glyph in
 * the chat. Nothing passes `src` yet — the realtime Sender carries no photo —
 * so today every avatar is initials; when a profile photo reaches the Sender,
 * only the call sites have to supply it.
 *
 * Decorative by default (`aria-hidden`): everywhere this is drawn, the name is
 * written beside it, and reading "N K" before "Netesh Kumar" is noise. Pass
 * `label` where it stands alone, e.g. the faces on the catch-up pill. */

const SIZES = {
  xs: "size-5 text-[8.5px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-[12px]",
  lg: "size-9 text-[13px]",
} as const;

export function SenderAvatar({
  name,
  identity,
  src,
  size = "md",
  ring = false,
  label,
  className = "",
}: {
  name: string;
  /** What the colour is keyed on — stable per person, unlike a display name. */
  identity: string;
  /** A photo URL. Optional; initials show whenever it is absent or fails. */
  src?: string;
  size?: keyof typeof SIZES;
  /** A thin brand ring — marks the host and panelists in a busy audience. */
  ring?: boolean;
  /** Accessible name, for when no visible name sits beside the avatar. */
  label?: string;
  className?: string;
}) {
  // Remembered per URL, so a new photo gets its own chance to load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const photo = src && src !== failedSrc ? src : null;

  return (
    <span
      className={`relative grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-semibold tracking-[0.01em] text-white ${SIZES[size]} ${
        ring ? "ring-[1.5px] ring-brand ring-offset-2 ring-offset-surface" : ""
      } ${className}`}
      style={{ background: hueFor(identity || name) }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(photo)}
          className="size-full object-cover"
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

/* A stand-in for a face that must not be shown or guessed at.
 *
 * Anonymous questions still carry their sender in the realtime packet, so the one
 * thing this must never do is fall back
 * to initials or to the identity-keyed colour: a colour that matches the same
 * person's chat avatar is as good as their name. A neutral surface and a glyph,
 * the same for everybody. */
export function GlyphAvatar({
  children,
  size = "md",
  tone = "neutral",
  className = "",
}: {
  children?: ReactNode;
  size?: keyof typeof SIZES;
  tone?: "neutral" | "ok";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 select-none place-items-center rounded-full border ${SIZES[size]} ${
        tone === "ok"
          ? "border-ok/30 bg-ok-soft text-ok"
          : "border-line-2 bg-surface-2 text-ink-3"
      } ${className}`}
    >
      {children ?? <PersonGlyph />}
    </span>
  );
}

function PersonGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-[60%]" fill="currentColor" aria-hidden focusable="false">
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4 20.5c.9-4 4.1-6.5 8-6.5s7.1 2.5 8 6.5z" />
    </svg>
  );
}

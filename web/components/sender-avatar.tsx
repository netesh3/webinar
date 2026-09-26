"use client";

import { useState } from "react";
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

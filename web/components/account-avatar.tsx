"use client";

import { useState } from "react";

/* The signed-in account's face: uploaded photo, then Google photo, then initials.
 *
 * Client-side because a photo that fails to load (a Google URL Google stopped
 * serving, a session that 401s the upload) has to fall back to initials rather
 * than a broken-image glyph. ui.tsx stays free of that state. */

export function AccountAvatar({
  initials,
  hue,
  photo,
  size = 28,
}: {
  initials: string;
  hue: string;
  /** Resolved photo URL. Empty means initials. */
  photo?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = photo && photo !== failed ? photo : null;

  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white"
      style={{
        background: hue,
        width: size,
        height: size,
        fontSize: size * 0.37,
      }}
      aria-hidden
    >
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element -- Google CDN or our own /api/auth/avatar; next/image cannot optimize either
        <img
          src={show}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(show)}
          className="size-full object-cover"
        />
      ) : (
        initials
      )}
    </span>
  );
}

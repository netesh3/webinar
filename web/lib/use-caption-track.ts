"use client";

import { useEffect, useState } from "react";

/* Loads a captions file (lib/caption-track.ts) and hands back a blob: URL for a <track>, or
 * null while loading and when there are none (the API answers 404 then): the player shows
 * its CC button only once there is something to show. The session cookie travels, as for
 * every API call. */
export function useCaptionTrack(url: string | undefined): string | null {
  const [loaded, setLoaded] = useState<{ url: string; blob: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let made: string | null = null;
    fetch(url, { credentials: "include" })
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        if (cancelled || !text || !text.startsWith("WEBVTT")) return;
        made = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        setLoaded({ url, blob: made });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url]);
  return loaded && loaded.url === url ? loaded.blob : null;
}

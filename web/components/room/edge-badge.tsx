"use client";

/* The host's notice while an Edge-delivery audience stream is still being prepared
 * (docs/edge-delivery.md). There used to be an "Edge · N watching" chip in the header too;
 * it was removed as noise — the participants panel's "Watching via stream" row covers who
 * is watching. Renders nothing for a standard webinar, or once the stream is live. */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AudienceStreamPreparing } from "@/lib/api-types";
import { useRoomUI } from "./context";

const POLL_MS = 5000;
// While the audience stream is being prepared, check often so the popup goes the moment it is live.
const POLL_PREPARING_MS = 2000;

export function EdgePreparingNotice() {
  const { slug } = useRoomUI();
  const [edge, setEdge] = useState(false);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await api.hostEdgeStatus(slug);
        if (cancelled) return;
        setEdge(status.delivery === "edge");
        const isPreparing = status.audienceStream === AudienceStreamPreparing;
        setPreparing(isPreparing);
        if (status.delivery !== "edge") return; // nothing to keep counting
        if (!cancelled) timer = setTimeout(poll, isPreparing ? POLL_PREPARING_MS : POLL_MS);
        return;
      } catch {
        // A panelist without access, or a blip: try again later.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug]);

  if (!edge || !preparing) return null;
  return <PreparingPopup />;
}

/* Shown to the host while the webinar is live but the audience has no picture yet — the mix
 * is starting, on an egress worker that may be booting (about a minute). Without it the host
 * saw "started" and an attendee count while every attendee saw "waiting". Top of the screen
 * and not modal: the host can keep setting up, and it goes the moment the stream is live. */
function PreparingPopup() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-16 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900/95 px-4 py-3 text-white shadow-2xl backdrop-blur"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">Getting your webinar ready for the audience…</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-white/70">
            We&apos;re starting the stream your attendees watch. This usually takes under a minute.
            You can keep setting up; this goes away as soon as they can see you.
          </p>
        </div>
      </div>
    </div>
  );
}

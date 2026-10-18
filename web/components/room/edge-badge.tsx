"use client";

/* The host's reminder that this webinar is on Edge delivery, with how many people are watching
 * the stream (docs/edge-delivery.md). Those viewers are not in the video room, so the
 * participant list does not show them; this count is the open event streams. Renders nothing
 * for a standard webinar. */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useRoomUI } from "./context";

const POLL_MS = 5000;

export function EdgeBadge() {
  const { slug } = useRoomUI();
  const [viewers, setViewers] = useState<number | null>(null);
  const [edge, setEdge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await api.hostEdgeStatus(slug);
        if (cancelled) return;
        setEdge(status.delivery === "edge");
        setViewers(status.viewers);
        if (status.delivery !== "edge") return; // nothing to keep counting
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

  if (!edge) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/85"
      title="Edge delivery: the audience watches a low-latency stream, not the video room"
    >
      <span className="inline-block size-1.5 rounded-full bg-sky-400" />
      Edge
      {viewers != null && <span className="tabular-nums text-white/60">· {viewers} watching</span>}
    </span>
  );
}

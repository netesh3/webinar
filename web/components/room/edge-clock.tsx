"use client";

import { useEffect, useState } from "react";
import { formatClock } from "@/lib/server-clock";

/** The server-synced clock, drawn the same way as the composite's (recorder-template /clock). */
export function EdgeClock({ offsetMs }: { offsetMs: number }) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setNow(Date.now() + offsetMs);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [offsetMs]);
  return (
    <span className="rounded bg-black/80 px-2 py-0.5 font-mono text-[13px] tabular-nums text-lime-300">
      {formatClock(now)}
    </span>
  );
}

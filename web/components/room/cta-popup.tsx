"use client";

import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "../icons";
import { useRoomUI } from "./context";

export function CtaPopup() {
  const { isHost, realtime } = useRoomUI();
  const offer = realtime.cta;
  const [hidden, setHidden] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!offer) return;
    card.current?.focus();
  }, [offer]);

  if (!offer || hidden === offer.id) return null;

  return (
    <div
      className="room-dark pointer-events-auto fixed inset-x-2 bottom-2 z-50 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[352px]"
      role="dialog"
      aria-modal="false"
      aria-label={offer.title}
    >
      <div
        ref={card}
        tabIndex={-1}
        className="rounded-2xl border border-line bg-surface p-3.5 shadow-2xl outline-none"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
              From the host
            </p>
            <p className="mt-1 text-[13.5px] leading-snug font-medium break-words text-ink">
              {offer.title}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setHidden(offer.id);
              if (isHost) void realtime.clearCta();
            }}
            aria-label="Dismiss"
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
        <a
          href={offer.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand text-[13px] font-medium text-white hover:bg-brand-hover"
        >
          {offer.label}
        </a>
      </div>
    </div>
  );
}

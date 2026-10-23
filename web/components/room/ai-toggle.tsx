"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { aiPaused, aiToggleConfirm, aiToggleVisible, sessionAIOn } from "@/lib/ai-session";
import type { ControlsPatch } from "@/lib/api-types";
import { SparklesIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The room's AI switch, top right of the header, for the host and co-hosts of an account
 * with AI (lib/ai-session.ts). On by default. Like every session control it is written to
 * the API, which persists it and broadcasts it in room metadata: nothing local is set, so
 * every host's header agrees. While on, a transcript is kept for the AI recap even with
 * captions hidden; off when the session ends, the session gets no recap.
 *
 * Off during a LIVE session pauses AI until it is turned back on (migration 0143): whatever is
 * said, asked or chatted meanwhile stays out of AI. Both directions ask first while live, so
 * a host knows a pause leaves a gap and a resume does not fill it. */
export function AIToggle() {
  const { isHost, controls, slug, status } = useRoomUI();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  if (!aiToggleVisible(isHost, controls)) return null;
  const on = sessionAIOn(controls);
  const paused = aiPaused(controls, status);

  const toggle = async () => {
    if (busy) return;
    const ask = aiToggleConfirm(on, status);
    if (ask && !window.confirm(ask)) return;
    setBusy(true);
    try {
      await api.updateControls(slug, { aiEnabled: !on } satisfies ControlsPatch);
      if (status === "live") notify(on ? "AI is paused." : "AI is back on for this session.", "info");
      else notify(on ? "AI is off for this session." : "AI is on for this session.", "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't apply.", "error");
    } finally {
      setBusy(false);
    }
  };

  // A plain toggle button (aria-pressed), no switch drawn inside it: filled
  // with the brand colour when on, outlined and neutral when off or paused.
  // The title says the state and what a click does.
  const title = on
    ? status === "live"
      ? "AI on: click to pause"
      : "AI on: click to turn off for this session"
    : paused
      ? "AI paused: click to resume"
      : "AI off: click to turn on";

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={paused ? "AI is paused for this session" : "AI for this session"}
      title={title}
      disabled={busy}
      onClick={() => void toggle()}
      className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-60 sm:h-8 sm:px-2.5 ${
        on
          ? "border-brand bg-brand text-white hover:bg-brand/90"
          : "border-white/25 bg-transparent text-white/70 hover:border-white/40 hover:text-white"
      }`}
    >
      <SparklesIcon className="size-4" />
      <span className="hidden sm:inline">{paused ? "AI paused" : "AI"}</span>
    </button>
  );
}

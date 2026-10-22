"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { AI_PAUSED_TOOLTIP, AI_TOGGLE_TOOLTIP, aiPaused, aiToggleConfirm, aiToggleVisible, sessionAIOn } from "@/lib/ai-session";
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

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={paused ? "AI is paused for this session" : "AI for this session"}
      title={paused ? AI_PAUSED_TOOLTIP : AI_TOGGLE_TOOLTIP}
      disabled={busy}
      onClick={() => void toggle()}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-60 ${
        on ? "bg-brand/25 text-white hover:bg-brand/35" : "bg-white/10 text-white/70 hover:bg-white/20"
      }`}
    >
      <SparklesIcon className={`size-3.5 ${on ? "text-[#a3c8ff]" : ""}`} />
      {paused ? "AI paused" : "AI"}
      <span
        aria-hidden
        className={`relative ml-0.5 inline-block h-3.5 w-6 rounded-full transition-colors ${on ? "bg-brand" : "bg-white/25"}`}
      >
        <span
          className={`absolute top-0.5 size-2.5 rounded-full bg-white transition-[left] ${on ? "left-3" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

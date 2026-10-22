"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import {
  AI_OFF_CONFIRM,
  AI_OFF_THIS_SESSION_TOOLTIP,
  AI_TOGGLE_TOOLTIP,
  aiLockedOff,
  aiToggleVisible,
} from "@/lib/ai-session";
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
 * Off at any point of a LIVE session keeps the whole session out of AI, even switched back on
 * (controls.aiOffThisSession). So switching it off while live asks first, and once it has
 * been off the switch reads off and is locked until the session ends: a switch that showed
 * "on" over a session the server had already taken out of AI is how the Q&A assistant
 * vanished mid-session with nothing on screen saying why. */
export function AIToggle() {
  const { isHost, controls, slug, status } = useRoomUI();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  if (!aiToggleVisible(isHost, controls)) return null;
  const locked = aiLockedOff(controls, status);
  const on = controls.aiEnabled && !locked;

  const toggle = async () => {
    if (busy || locked) return;
    if (on && status === "live" && !window.confirm(AI_OFF_CONFIRM)) return;
    setBusy(true);
    try {
      await api.updateControls(slug, { aiEnabled: !on } satisfies ControlsPatch);
      notify(on ? "AI is off for the rest of this session." : "AI is on for this session.", "info");
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
      aria-label={locked ? "AI is off for the rest of this session" : "AI for this session"}
      title={locked ? AI_OFF_THIS_SESSION_TOOLTIP : AI_TOGGLE_TOOLTIP}
      disabled={busy || locked}
      onClick={() => void toggle()}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-60 ${
        on ? "bg-brand/25 text-white hover:bg-brand/35" : "bg-white/10 text-white/70 hover:bg-white/20"
      }`}
    >
      <SparklesIcon className={`size-3.5 ${on ? "text-[#a3c8ff]" : ""}`} />
      {locked ? "AI off" : "AI"}
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

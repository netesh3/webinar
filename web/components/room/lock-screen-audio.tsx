"use client";

import { useEffect, useState } from "react";
import {
  LOCK_SCREEN_KEY,
  isAndroid,
  lockScreenChoice,
  setLockScreenState,
  silentWav,
} from "@/lib/lock-screen-audio";

/* Keeps the room's sound playing on Android with the screen locked. An experiment, off unless
 * the room link carried ?bg=1: why, and what it is testing, is lib/lock-screen-audio.ts.
 *
 * While it runs, an inaudible clip plays on loop and the lock screen shows the webinar's
 * title, the way it would for a podcast. The card's pause silences the webinar and its play
 * brings it back. So does coming back to the page: a webinar left silent from a lock screen
 * nobody remembers pausing would look broken.
 *
 * Returns the volume for RoomAudioRenderer. Undefined whenever this is not running, which
 * leaves the room's audio exactly as it was before this existed.
 */
export function useLockScreenAudio(
  topic: string,
  imageUrl: string | undefined,
  /** False once the room has ended or failed: the card must not outlive the webinar. */
  active: boolean,
): number | undefined {
  // Read once, at mount: the flag belongs to the link this page was opened with.
  const [choice] = useState(() => {
    if (typeof window === "undefined" || !isAndroid(navigator.userAgent)) {
      return { on: false } as ReturnType<typeof lockScreenChoice>;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LOCK_SCREEN_KEY);
    } catch {
      // Storage refused (private browsing, a blocked context): only the link counts.
    }
    return lockScreenChoice(window.location.search, stored);
  });
  const [held, setHeld] = useState(false);

  useEffect(() => {
    try {
      if (choice.store === "1") localStorage.setItem(LOCK_SCREEN_KEY, "1");
      else if (choice.store === null) localStorage.removeItem(LOCK_SCREEN_KEY);
    } catch {
      // As above: this visit still follows the link.
    }
  }, [choice]);

  const on = choice.on && active && typeof navigator !== "undefined" && "mediaSession" in navigator;

  useEffect(() => {
    if (!on) return;
    const session = navigator.mediaSession;
    const url = URL.createObjectURL(new Blob([silentWav()], { type: "audio/wav" }));
    const clip = document.createElement("audio");
    clip.src = url;
    clip.loop = true;
    clip.hidden = true;
    // Never muted, and never at volume 0: Chrome leaves a muted player out of the media
    // session, and being in it is the clip's only job.
    document.body.append(clip);
    setLockScreenState("waiting");

    // Paused from the lock-screen card, as opposed to by the system.
    let fromCard = false;

    const play = () => {
      if (fromCard) return;
      clip.play().then(
        () => {
          setLockScreenState("playing");
          session.playbackState = "playing";
          window.removeEventListener("pointerup", play);
          window.removeEventListener("keydown", play);
        },
        // Not allowed yet: nobody has tapped this page. The next tap tries again — the same
        // taps that let the room's own sound play (AutoStartAudio in webinar-room.tsx).
        () => {},
      );
    };

    session.setActionHandler("pause", () => {
      fromCard = true;
      clip.pause();
      setHeld(true);
      setLockScreenState("paused");
      session.playbackState = "paused";
    });
    session.setActionHandler("play", () => {
      fromCard = false;
      setHeld(false);
      play();
    });

    // Paused by the system instead — a phone call, another app's audio taking over. Noted for
    // the report; the webinar's own sound is not this clip's to stop.
    const onClipPause = () => setLockScreenState("paused");
    clip.addEventListener("pause", onClipPause);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (fromCard) {
        fromCard = false;
        setHeld(false);
      }
      if (clip.paused) play();
    };
    document.addEventListener("visibilitychange", onVisible);

    window.addEventListener("pointerup", play);
    window.addEventListener("keydown", play);
    play();

    return () => {
      window.removeEventListener("pointerup", play);
      window.removeEventListener("keydown", play);
      document.removeEventListener("visibilitychange", onVisible);
      clip.removeEventListener("pause", onClipPause);
      clip.pause();
      clip.removeAttribute("src");
      clip.load();
      clip.remove();
      URL.revokeObjectURL(url);
      session.setActionHandler("pause", null);
      session.setActionHandler("play", null);
      session.metadata = null;
      session.playbackState = "none";
      setLockScreenState("off");
    };
  }, [on]);

  // The card follows the title: a host can rename the session while it runs.
  useEffect(() => {
    if (!on) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: topic,
      artist: "Live webinar",
      artwork: [{ src: imageUrl || "/icon.png" }],
    });
  }, [on, topic, imageUrl]);

  if (!on) return undefined;
  return held ? 0 : 1;
}

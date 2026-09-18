"use client";

import { Track, type LocalAudioTrack } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import { useEffect, useRef } from "react";
import { useNoiseSuppression } from "@/lib/noise-suppression";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/** The mic track this participant is publishing, if any. Same shape as
 *  background-picker.tsx's useCameraTrack, for the audio side. */
function useMicTrack(): LocalAudioTrack | undefined {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(Track.Source.Microphone);
  return publication?.track as LocalAudioTrack | undefined;
}

/** Applies the stored noise-suppression preference to whatever mic track is
 *  currently published. Renders nothing, mounted for the whole session — same
 *  shape as VirtualBackground (background-picker.tsx), and for the same reason:
 *  a mic that is stopped and restarted, or switched to a different device,
 *  republishes as a new track, and without this the enhancement would come off
 *  along with it. */
export function NoiseSuppression() {
  const { prefs } = useRoomUI();
  const { notify } = useToast();
  const track = useMicTrack();
  const { error } = useNoiseSuppression(track, prefs.noiseSuppression);

  // Told once per failure, not on every render it stays true — the same reasoning
  // as the background's slow-device warning.
  const lastError = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastError.current) notify(error, "info");
    lastError.current = error;
  }, [error, notify]);

  return null;
}

"use client";

import { useRoomContext } from "@livekit/components-react";
import { useEffect, useState } from "react";
import { useChatSound } from "@/lib/chat-notify";
import { deviceLabel, supportsOutputSelection, useDevices } from "@/lib/media";
import { useWaitingTune } from "@/lib/waiting-tune";
import { Alert, Select, Toggle } from "../controls";
import { BackgroundPicker } from "./background-picker";
import { LowLightSlider } from "./low-light";
import { NetworkReadout } from "./network-readout";
import { useRoomUI } from "./context";

/* Camera, microphone and speaker.
 *
 * Changes apply to the live session immediately — `switchActiveDevice` swaps the
 * track underneath an established connection, so nobody has to rejoin to move to
 * their headset.
 *
 * Quality is the exception. Capture resolution is fixed when a track is created,
 * so changing it republishes the camera. That is a visible half-second of black
 * for the audience, which is why it is stated rather than hidden.
 */

/* Rendered as the body of a floating window, so there is no `open` prop and no
 * dialog chrome here — the window supplies both, and it is mounted only while it
 * is open. That is why `useDevices(true)`: being mounted IS being open. */
export function DeviceSettings() {
  const room = useRoomContext();
  const { prefs, updatePrefs, permissions } = useRoomUI();
  const { devices, refresh } = useDevices(true);
  const chatSound = useChatSound();
  const waitingTune = useWaitingTune();
  const [error, setError] = useState<string | null>(null);

  // Labels are hidden until the page holds a media permission, so re-enumerate
  // on mount: by then a publisher has usually granted it and the picker can show
  // real device names instead of blanks.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function switchDevice(
    kind: "audioinput" | "videoinput" | "audiooutput",
    deviceId: string,
  ) {
    setError(null);
    try {
      await room.switchActiveDevice(kind, deviceId);
      updatePrefs(
        kind === "audioinput"
          ? { audioInput: deviceId }
          : kind === "videoinput"
            ? { videoInput: deviceId }
            : { audioOutput: deviceId },
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't switch: ${err.message}`
          : "That device couldn't be opened. It may be in use by another app.",
      );
    }
  }

  const canPickOutput = supportsOutputSelection();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
      <div className="space-y-4">
        <p className="text-[12px] text-ink-3">
          Applies to this session and is remembered for the next one.
        </p>
        {error && <Alert tone="error">{error}</Alert>}

        {permissions.canShareCamera && (
          <>
            <Select
              label="Camera"
              value={prefs.videoInput ?? ""}
              onChange={(id) => void switchDevice("videoinput", id)}
            >
              <option value="">System default</option>
              {devices.videoInput.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {deviceLabel(d, i, "Camera")}
                </option>
              ))}
            </Select>

            <Select
              label="Microphone"
              value={prefs.audioInput ?? ""}
              onChange={(id) => void switchDevice("audioinput", id)}
            >
              <option value="">System default</option>
              {devices.audioInput.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {deviceLabel(d, i, "Microphone")}
                </option>
              ))}
            </Select>
          </>
        )}

        {canPickOutput ? (
          <Select
            label="Speaker"
            value={prefs.audioOutput ?? ""}
            onChange={(id) => void switchDevice("audiooutput", id)}
          >
            <option value="">System default</option>
            {devices.audioOutput.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, i, "Speaker")}
              </option>
            ))}
          </Select>
        ) : (
          <Alert>
            This browser doesn&apos;t let a page choose the speaker. Pick the output
            device in your operating system&apos;s sound settings.
          </Alert>
        )}

        {/* Not a device, and deliberately not gated on being able to publish — an
            attendee following a busy chat has the same reason to want this as a host. Off
            unless it is switched on here, and silent while this browser is sharing a
            screen: see lib/chat-notify.ts. */}
        <div className="border-t border-line pt-1">
          <Toggle
            checked={chatSound.enabled}
            onChange={chatSound.setEnabled}
            label="Sound for new chat messages"
            description="A short cue when chat arrives while the panel is closed. Never plays while you are sharing your screen, because a share usually publishes its audio to the room."
          />
        </div>

        {/* Not gated on role for the same reason the toggle above isn't: this is a
            per-browser preference, and a host today may be an attendee elsewhere on the
            same browser. It only ever actually plays on the "waiting for the host"
            screen — see WaitingForStage in stage.tsx — which nobody presenting is shown. */}
        <div className="border-t border-line pt-1">
          <Toggle
            checked={waitingTune.enabled}
            onChange={waitingTune.setEnabled}
            label="Tune while waiting for the host"
            description="A soft chime that repeats quietly on the “waiting for the host” screen. Stops as soon as the host or a panelist goes live."
          />
        </div>

        {(permissions.canSpeak || permissions.canShareCamera) && (
          <p className="text-[12px] leading-relaxed text-ink-3">
            Keyboard: M mutes, V toggles the camera, hold Space to talk while muted.
          </p>
        )}

        {permissions.canShareCamera && (
          <>
            {/* What used to be a "Send video at" picker.
                Removed rather than relocated: the old control restarted the camera to apply
                a resolution the connection might not sustain a minute later, and the app
                already measures the uplink every two seconds and moves the published ladder
                itself. What belongs here is not a choice but a reading, and the connection
                panel below is where it is. */}
            <p className="text-[12px] leading-relaxed text-ink-3">
              Video quality is set automatically from your connection — it drops when your
              upload struggles and comes back when it recovers. The reading is below.
            </p>

            <div className="border-t border-line pt-3">
              <BackgroundPicker />
            </div>

            {/* Below the background rather than above it, because the two share a
                processor and the order matches what the lift does: with a background on
                it lights the person, so the thing it depends on is the thing above it. */}
            <div className="border-t border-line pt-3">
              <LowLightSlider />
            </div>

            <div className="border-t border-line pt-3">
              <NetworkReadout />
            </div>

            <div className="border-t border-line pt-1">
              <Toggle
                checked={prefs.noiseSuppression}
                onChange={(v) => updatePrefs({ noiseSuppression: v })}
                label="Noise suppression"
                description="Applies immediately. Turn it off if you're playing music through your microphone."
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

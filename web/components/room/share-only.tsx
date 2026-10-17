"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { bannerText } from "@/lib/share-only";
import { useStageShareActive } from "@/lib/use-share-only";
import { EyeIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The host's side of "Show only the shared video to the audience".
 *
 * The decision of what the audience sees is lib/share-only.ts; the switch is a
 * session control on the server (PATCH /controls, host and co-hosts only), so
 * every audience browser, the recorder and the broadcast follow it within a
 * metadata push. Everything here only flips it and tells the stage it is on.
 */

export const SHARE_ONLY_LABEL = "Show only the shared video to the audience";
export const SHARE_ONLY_MUTE_LABEL = "Also mute stage microphones for the audience";

/** The control, for whoever may change it. `canControl` is false for a panelist:
 *  they see the banner but not the switch. */
export function useShareOnlyControl() {
  const { slug, controls, isHost } = useRoomUI();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

  const on = controls.audienceShareOnly === true;
  const muteStage = controls.audienceMuteStage === true;

  async function update(patch: ControlsPatch, message: string): Promise<boolean> {
    setBusy(true);
    try {
      await api.updateControls(slug, patch);
      notify(message, "ok");
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't apply.", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    on,
    muteStage,
    busy,
    canControl: isHost,
    /** Turning it on mutes the stage for the audience too unless said otherwise —
     *  the server's default, so a stray voice never plays over the clip. */
    setOn: (next: boolean) =>
      update(
        { audienceShareOnly: next },
        next
          ? "The audience now sees only the shared video."
          : "The audience sees the stage again.",
      ),
    setMuteStage: (next: boolean) =>
      update(
        { audienceMuteStage: next },
        next
          ? "Stage microphones are muted for the audience."
          : "The audience can hear the stage again.",
      ),
  };
}

/** A compact switch for the presenter's own share notice, which is dark and has
 *  no room for a full Toggle row. Host and co-hosts only. */
export function ShareOnlySwitch({ small = false }: { small?: boolean }) {
  const control = useShareOnlyControl();
  if (!control.canControl) return null;
  return (
    <div className={`flex flex-col items-center gap-1.5 ${small ? "text-[11.5px]" : "text-[12.5px]"}`}>
      <DarkCheck
        checked={control.on}
        disabled={control.busy}
        onChange={(v) => void control.setOn(v)}
        label={SHARE_ONLY_LABEL}
      />
      {control.on && (
        <DarkCheck
          checked={control.muteStage}
          disabled={control.busy}
          onChange={(v) => void control.setMuteStage(v)}
          label={SHARE_ONLY_MUTE_LABEL}
        />
      )}
    </div>
  );
}

function DarkCheck({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={`inline-flex max-w-full items-center gap-2 rounded-lg bg-white/10 px-2.5 py-1.5 font-medium text-white/90 ${
        disabled ? "opacity-60" : "cursor-pointer hover:bg-white/15"
      }`}
    >
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-brand"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

/** What the stage sees while the audience sees only the share: a persistent pill
 *  on the stage, with one-click Turn off for the host and co-hosts. Nothing for the
 *  audience, who simply see the video. */
export function ShareOnlyBanner() {
  const { controls, isHost, join, permissions } = useRoomUI();
  const shareActive = useStageShareActive();
  const control = useShareOnlyControl();
  const onStage =
    isHost || join.canPublish || permissions.canShareCamera || permissions.canShareScreen;
  if (!onStage || controls.audienceShareOnly !== true) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-3">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-white/20 bg-black/85 px-3 py-1.5 text-[12px] text-white shadow-2xl backdrop-blur-md"
      >
        <EyeIcon className="size-3.5 shrink-0 text-white/70" />
        <span className="min-w-0 truncate font-medium">
          {bannerText({ muteStage: controls.audienceMuteStage === true, shareActive })}
        </span>
        {control.canControl && (
          <button
            type="button"
            disabled={control.busy}
            onClick={() => void control.setOn(false)}
            className="shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-white/25 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

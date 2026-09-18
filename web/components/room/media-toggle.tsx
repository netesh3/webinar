"use client";

import { useRoomContext } from "@livekit/components-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { backgroundsSupported } from "@/lib/backgrounds";
import { useCompact, useMediaToggleSize } from "@/lib/compact";
import {
  deviceLabel,
  supportsOutputSelection,
  useDevices,
} from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { CheckIcon, ChevronDownIcon } from "../icons";
import { Spinner } from "../controls";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Mic / camera on the control bar.
 *
 * Split the way Zoom does: the face toggles the track, the caret opens a menu of
 * devices and the few extras we actually have. Choosing a headset is not the same
 * action as going silent, and burying it behind a long-press is how phones lose it.
 *
 * The menu is honest about what this product can do. Blur and noise suppression
 * are real prefs. Auto-frame, phone audio, and a speaker-test wizard are not, so
 * they are not offered.
 *
 * Mobile sizing (desktop keeps a flat min-w-14 main button and w-7 caret —
 * `sm:` has room to spare regardless of phone width) comes from
 * useMediaToggleSize's three tiers, not one flat guess: a 320px phone and a
 * 430px one differ by more than this button's whole width, and a size fixed
 * for either end either overflows the small one or wastes the room the big
 * one has. Applied as an inline width, not a Tailwind class, because the
 * tier is a JS-computed number (from matchMedia, re-evaluated on resize),
 * not a static breakpoint. Every tier's numbers are measured against this
 * exact markup — see MEDIA_TOGGLE_TIERS' own comment in lib/compact.ts —
 * and control-bar.tsx's leftReservePx has to reserve exactly what this
 * renders, by hand; there is no single source of truth between an
 * out-of-flow absolute cluster and the padding that reserves room for it. */

const subscribeNothing = () => () => {};

export function MediaToggle({
  label,
  icon,
  onClick,
  active,
  danger,
  dimmed,
  busy,
  meter,
  shortcut,
  deviceKind,
  currentDeviceId,
  onSelectDevice,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active: boolean;
  danger?: boolean;
  dimmed?: boolean;
  busy?: boolean;
  meter?: React.ReactNode;
  shortcut?: string;
  deviceKind: "audioinput" | "videoinput";
  currentDeviceId?: string;
  onSelectDevice?: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { devices } = useDevices(open);
  const { prefs, updatePrefs, tools } = useRoomUI();
  const room = useRoomContext();
  const { notify } = useToast();
  const compact = useCompact();
  const { mainPx, chevPx } = useMediaToggleSize();
  const canPickOutput = useSyncExternalStore(
    subscribeNothing,
    supportsOutputSelection,
    () => false,
  );

  const isAudio = deviceKind === "audioinput";
  const inputs = isAudio ? devices.audioInput : devices.videoInput;
  const kindLabel = isAudio ? "microphone" : "camera";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const tone = dimmed
    ? "text-white/35"
    : danger
      ? "bg-live-soft text-live"
      : active
        ? "bg-white/20 text-white"
        : "text-white/75 hover:bg-white/10 hover:text-white";

  async function selectOutput(deviceId: string) {
    try {
      await room.switchActiveDevice("audiooutput", deviceId);
      updatePrefs({ audioOutput: deviceId });
    } catch (err) {
      notify(describeMediaError(err, "devices"), "error");
    }
  }

  return (
    <div ref={wrap} className="relative">
      <div className={`flex items-stretch overflow-hidden rounded-lg ${tone}`}>
        <button
          type="button"
          onClick={onClick}
          aria-label={shortcut ? `${label} (${shortcut})` : label}
          aria-keyshortcuts={shortcut}
          aria-pressed={active}
          disabled={busy}
          style={compact ? { width: mainPx } : undefined}
          className="relative flex flex-col items-center justify-center gap-0.5 px-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 sm:min-w-14 sm:px-2"
        >
          <span className="flex h-10 flex-col items-center justify-center gap-0.5">
            {busy ? <Spinner className="size-5" /> : (meter ?? icon)}
            <span className="hidden text-[9.5px] leading-none font-medium sm:block">
              {label}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={`Choose ${kindLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          style={compact ? { width: chevPx } : undefined}
          className="grid shrink-0 place-items-center border-l border-white/15 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 sm:w-7"
        >
          <ChevronDownIcon className="size-3.5 rotate-180" />
        </button>
      </div>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={isAudio ? "Audio devices" : "Video devices"}
          className="room-dark absolute bottom-full left-0 z-50 mb-2 w-[18.5rem] max-w-[calc(100vw-1rem)] max-h-[min(24rem,calc(100dvh-6rem))] overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-3">
            {isAudio ? "Select a microphone" : "Select a camera"}
          </p>
          <DeviceList
            devices={inputs}
            kind={isAudio ? "Microphone" : "Camera"}
            currentId={currentDeviceId}
            onPick={(id) => {
              onSelectDevice?.(id);
              setOpen(false);
            }}
          />

          {isAudio && canPickOutput && (
            <>
              <div className="my-1 h-px bg-line" />
              <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-3">
                Select a speaker
              </p>
              <DeviceList
                devices={devices.audioOutput}
                kind="Speaker"
                currentId={prefs.audioOutput}
                onPick={(id) => {
                  void selectOutput(id);
                  setOpen(false);
                }}
              />
            </>
          )}

          {isAudio && (
            <>
              <div className="my-1 h-px bg-line" />
              <MenuToggle
                checked={prefs.noiseSuppression}
                onChange={(on) => updatePrefs({ noiseSuppression: on })}
                label="Noise suppression"
              />
            </>
          )}

          {!isAudio && backgroundsSupported() && (
            <>
              <div className="my-1 h-px bg-line" />
              <MenuToggle
                checked={prefs.background.mode !== "none"}
                onChange={(on) =>
                  updatePrefs({
                    background: on
                      ? prefs.background.mode === "none"
                        ? { mode: "blur" }
                        : prefs.background
                      : { mode: "none" },
                  })
                }
                label={
                  prefs.background.mode === "image"
                    ? "Virtual background"
                    : "Blur my background"
                }
              />
            </>
          )}

          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              tools.open("settings");
            }}
            className="flex min-h-11 w-full items-center px-3 text-left text-[13px] text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:bg-surface-2"
          >
            {isAudio ? "Audio settings" : "Video settings"}
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceList({
  devices,
  kind,
  currentId,
  onPick,
}: {
  devices: MediaDeviceInfo[];
  kind: string;
  currentId?: string;
  onPick: (id: string) => void;
}) {
  if (devices.length === 0) {
    return (
      <p className="px-3 py-2 text-[12.5px] text-ink-3">
        No {kind.toLowerCase()} devices listed yet. Allow access if the browser asks.
      </p>
    );
  }

  const selected =
    currentId && devices.some((d) => d.deviceId === currentId)
      ? currentId
      : devices.find((d) => d.deviceId === "default")?.deviceId ?? devices[0]?.deviceId;

  return (
    <>
      {devices.map((d, i) => {
        const active = d.deviceId === selected;
        return (
          <button
            key={d.deviceId}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => onPick(d.deviceId)}
            className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:bg-surface-2"
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {active && <CheckIcon className="size-3.5 text-brand" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{menuLabel(d, i, kind)}</span>
          </button>
        );
      })}
    </>
  );
}

/** "Same as system" only when the browser actually exposes a default device id.
 *  Inventing that row for a list that is only named devices would be a lie. */
function menuLabel(device: MediaDeviceInfo, index: number, kind: string): string {
  const base = deviceLabel(device, index, kind);
  if (device.deviceId !== "default") return base;
  const named = base.replace(/^Default\s*[-–—]\s*/i, "").trim();
  return named && named.toLowerCase() !== "default" && named !== kind
    ? `Same as system (${named})`
    : "Same as system";
}

function MenuToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 hover:bg-surface-2">
      <span className="text-[13px] text-ink">{label}</span>
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          className="peer size-0 opacity-0"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden
          className={`block h-[18px] w-[32px] rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${
            checked ? "bg-brand" : "bg-line-2"
          }`}
        />
        <span
          aria-hidden
          className={`pointer-events-none absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white transition-transform ${
            checked ? "translate-x-[14px]" : ""
          }`}
        />
      </span>
    </label>
  );
}

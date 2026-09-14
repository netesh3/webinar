"use client";

import { useEffect, useId, useRef, useState } from "react";
import { deviceLabel, useDevices } from "@/lib/media";
import { ChevronDownIcon } from "../icons";
import { Spinner } from "../controls";

/* Mic / camera on the control bar.
 *
 * The main face is the toggle: a red slash and a flipped label when it is off,
 * so muted is not a colour you have to remember. The caret is a separate
 * control because choosing a headset mid-sentence is not the same action as
 * going silent, and burying the picker behind a long-press is how phones lose
 * it.
 */

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
  const list =
    deviceKind === "audioinput" ? devices.audioInput : devices.videoInput;
  const kindLabel = deviceKind === "audioinput" ? "Microphone" : "Camera";

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

  return (
    <div ref={wrap} className="relative flex items-stretch">
      <button
        type="button"
        onClick={onClick}
        aria-label={shortcut ? `${label} (${shortcut})` : label}
        aria-keyshortcuts={shortcut}
        aria-pressed={active}
        disabled={busy}
        className="relative shrink-0 rounded-lg rounded-r-none outline-none focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <BarFace label={label} active={active} danger={danger} dimmed={dimmed}>
          {busy ? <Spinner className="size-5" /> : (meter ?? icon)}
        </BarFace>
      </button>
      <button
        type="button"
        aria-label={`Choose ${kindLabel.toLowerCase()}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="grid w-11 shrink-0 place-items-center rounded-lg rounded-l-none border-l border-white/10 outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:w-8"
      >
        <BarFace
          label=""
          active={active}
          danger={danger}
          dimmed={dimmed}
          className="min-w-0 px-0 sm:min-w-0"
        >
          <ChevronDownIcon className="size-3.5" />
        </BarFace>
      </button>
      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label={`${kindLabel} devices`}
          className="room-dark absolute bottom-full left-0 z-50 mb-2 min-w-[14rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          {list.length === 0 ? (
            <p className="px-3 py-2.5 text-[12.5px] text-ink-3">
              No {kindLabel.toLowerCase()}s listed yet. Allow access if the
              browser asks.
            </p>
          ) : (
            list.map((d, i) => {
              const selected = d.deviceId === currentDeviceId;
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onSelectDevice?.(d.deviceId);
                    setOpen(false);
                  }}
                  className="flex min-h-11 w-full items-center px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {deviceLabel(d, i, kindLabel)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function BarFace({
  label,
  active = false,
  danger = false,
  dimmed = false,
  className = "",
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  dimmed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const tone = dimmed
    ? "text-white/35"
    : danger
      ? "bg-live-soft text-live"
      : active
        ? "bg-white/20 text-white"
        : "text-white/75 hover:bg-white/10 hover:text-white";

  return (
    <span
      className={`inline-flex h-10 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-2 transition-colors sm:min-w-14 ${tone} ${className}`}
    >
      {children}
      {label ? (
        <span className="hidden text-[9.5px] leading-none font-medium sm:block">
          {label}
        </span>
      ) : null}
    </span>
  );
}

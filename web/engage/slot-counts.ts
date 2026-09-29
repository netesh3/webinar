"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { SlotReminder, type MessageSlot } from "@/lib/api-types";
import { engageApi } from "./api";
import { readSlots, slotVersion, subscribeSlots, writeSlots } from "./slot-cache";

const slotFlight = new Map<string, Promise<void>>();

/* How many attendee messages actually go out on a channel.
 *
 * Resolved slots are the source of truth (GET .../messages → ResolveSlots).
 * options.whatsappReminders and options.emailReminders are only a fallback for
 * a webinar whose slots could not be loaded — new webinars no longer set the
 * WhatsApp flag, so counting it reports them as off. */

export type WebinarSlotsState =
  | { status: "loading" }
  | { status: "ready"; slots: MessageSlot[] }
  | { status: "unavailable" };

/** One webinar's resolved slots. `unavailable` means the caller should use the
 *  legacy option; an empty ready list is real data and counts as zero. */
export function useWebinarMessageSlots(slug: string): WebinarSlotsState {
  const version = useSyncExternalStore(
    (cb) => subscribeSlots(slug, cb),
    () => slotVersion(slug),
    () => 0,
  );
  const cached = readSlots(slug);
  const [state, setState] = useState<WebinarSlotsState>(() =>
    cached ? { status: "ready", slots: cached } : { status: "loading" },
  );
  const [seen, setSeen] = useState(`${slug}:${version}`);
  const mark = `${slug}:${version}`;
  if (mark !== seen) {
    setSeen(mark);
    const next = readSlots(slug);
    setState(next ? { status: "ready", slots: next } : { status: "loading" });
  }

  useEffect(() => {
    if (readSlots(slug)) return;
    let cancelled = false;
    const load = () =>
      engageApi
        .crmWebinarMessages(slug)
        .then((res) => {
          if (!Array.isArray(res.slots)) {
            if (!cancelled) setState({ status: "unavailable" });
            return;
          }
          writeSlots(slug, res.slots);
          if (!cancelled) setState({ status: "ready", slots: res.slots });
        })
        .catch(() => {
          if (!cancelled) setState({ status: "unavailable" });
        });
    const pending = slotFlight.get(slug);
    const run = pending ?? load();
    if (!pending) slotFlight.set(slug, run);
    run.finally(() => {
      if (slotFlight.get(slug) === run) slotFlight.delete(slug);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, version]);

  return state;
}

/** Enabled slots whose channels include `channel`. */
export function countEnabledChannel(slots: MessageSlot[], channel: string): number {
  return slots.filter(
    (slot) => slot.enabled && (slot.channels ?? []).includes(channel),
  ).length;
}

/** True when slot data says the channel is on. Null while slots are still loading,
 *  so a screen can wait instead of flashing the legacy flag. When slots never
 *  arrive, `legacy` is the answer. */
export function channelEnabled(
  state: WebinarSlotsState,
  channel: string,
  legacy: boolean,
): boolean | null {
  if (state.status === "loading") return null;
  if (state.status === "unavailable") return legacy;
  return countEnabledChannel(state.slots, channel) > 0;
}

/** Minutes before the start for the reminder slot, when it sends on `channel`.
 *  Empty when the slot is off or does not use that channel. Null while loading
 *  or when slots are missing — the caller keeps options.reminders. */
export function reminderMinutes(
  state: WebinarSlotsState,
  channel: string,
): number[] | null {
  if (state.status !== "ready") return null;
  const slot = state.slots.find((item) => item.kind === SlotReminder);
  if (!slot?.enabled || !(slot.channels ?? []).includes(channel)) return [];
  return (slot.timing.minutes ?? []).filter((n) => n > 0);
}

"use client";

import { useSyncExternalStore } from "react";

/* Background effects, paused for CPU.
 *
 * Blur and virtual backgrounds are the single largest per-frame CPU cost a presenter can turn
 * on (segmentation + compositing, every frame, on the main thread's GPU queue). When the CPU
 * ladder (network.ts, ADAPT.cpu) reaches its "effects" rung it pauses them here; the room's
 * VirtualBackground reads this store, applies "none" instead of the stored choice, and says so
 * in a toast. The stored preference is never touched, so the choice comes back on its own when
 * the ladder recovers, and survives a reload.
 *
 * `wanted` is the other direction: whether the presenter has an effect on at all, so the
 * ladder can skip the rung (pausing nothing is not a step).
 */

type State = { paused: boolean; wanted: boolean };
let state: State = { paused: false, wanted: false };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  const merged = { ...state, ...next };
  if (merged.paused === state.paused && merged.wanted === state.wanted) return;
  state = merged;
  listeners.forEach((l) => l());
}

export function setEffectsPausedForCpu(paused: boolean): void {
  set({ paused });
}

export function effectsPausedForCpu(): boolean {
  return state.paused;
}

export function setEffectsWanted(wanted: boolean): void {
  set({ wanted });
}

export function effectsWanted(): boolean {
  return state.wanted;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useEffectsPausedForCpu(): boolean {
  return useSyncExternalStore(subscribe, effectsPausedForCpu, () => false);
}

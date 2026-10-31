/**
 * Dedicated resources for a live webinar: GPU, Chromium timers, process
 * priority. Power-save blockers live in power.ts and call into this file.
 *
 * Chromium otherwise treats a hidden / occluded / unfocused window as
 * background work: timers slow down, the renderer is deprioritised, and a
 * dual-GPU laptop may pick the power-saving GPU. LiveKit encode, decode and
 * adaptiveStream all run on those timers. The flags below are the same
 * cluster Zoom-class Electron apps set so a meeting keeps a full time slice.
 *
 * Must be applied before app.whenReady() (Electron ignores later switches).
 * Hardware acceleration is left on — we never call app.disableHardwareAcceleration().
 */

import os from "node:os";

export const CHROMIUM_QOS_SWITCHES = [
  // Hidden-window setTimeout / rAF keep running at full rate (encoder pacing,
  // getStats, adaptiveStream). Default Chromium clamps them after a few seconds.
  "disable-background-timer-throttling",
  // A window behind the share picker or another app is "occluded"; without this
  // Chromium backgrounds it and encode stalls.
  "disable-backgrounding-occluded-windows",
  // Same for the renderer process when the window is not focused.
  "disable-renderer-backgrounding",
  // Dual-GPU Windows laptops: prefer the discrete GPU for WebRTC / WebGL.
  // No-op on Apple silicon (one GPU).
  "force-high-performance-gpu",
] as const;

export function applyChromiumQosFlags(commandLine: { appendSwitch(s: string): void }): void {
  for (const flag of CHROMIUM_QOS_SWITCHES) commandLine.appendSwitch(flag);
}

/** Above-normal while a call is live; normal otherwise. Not HIGHEST — that
 *  starves the OS compositor and makes the rest of the machine feel stuck. */
export function callProcessPriorityLevel(on: boolean): number {
  const p = os.constants.priority;
  return on ? p.PRIORITY_ABOVE_NORMAL : p.PRIORITY_NORMAL;
}

export function applyCallProcessPriority(on: boolean): void {
  try {
    os.setPriority(callProcessPriorityLevel(on));
  } catch {
    // macOS / some Windows policies refuse a raise without privileges.
  }
}

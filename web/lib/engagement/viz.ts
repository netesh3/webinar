/* Pure maths behind the hand-rolled SVG charts and heatmaps. No React, so node tests it. */

import type { EngagementAxis } from "../api-types.ts";

export interface Pt {
  x: number;
  y: number;
}

export const NOT_PRESENT = "#f2f5f7";

/** Attendee heatmap cell: grey absent; pale blue watching (paler under 60% of the bucket);
 *  three stronger blues for 1, 2–3 and 4+ interactions. Presence is 0..100. */
export function cellColor(presencePct: number, intensity: number): string {
  if (presencePct <= 0) return NOT_PRESENT;
  if (intensity <= 0) return presencePct < 60 ? "#e3ecff" : "#cddcff";
  if (intensity <= 1) return "#94b6ff";
  if (intensity <= 3) return "#4f88ff";
  return "#0b47cc";
}

export const HEAT_LEGEND = [
  { label: "Not in room", color: NOT_PRESENT },
  { label: "Watching", color: "#cddcff" },
  { label: "1 action", color: "#94b6ff" },
  { label: "2–3", color: "#4f88ff" },
  { label: "4+", color: "#0b47cc" },
] as const;

/** Opacity for an activity cell, normalised per row so a quiet type still shows its peaks. */
export function activityAlpha(value: number, rowMax: number): number {
  if (value <= 0 || rowMax <= 0) return 0;
  return 0.15 + 0.85 * Math.min(1, value / rowMax);
}

export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Round a chart's y-maximum up to a tidy gridline value (never zero). */
export function niceMax(max: number): number {
  if (max <= 10) return 10;
  const step = max <= 50 ? 10 : max <= 200 ? 25 : max <= 1000 ? 100 : 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
}

/** Minute tick spacing that keeps a 40-minute and a 4-hour session equally readable. */
export function tickStep(spanMin: number): number {
  if (spanMin <= 90) return 15;
  if (spanMin <= 180) return 30;
  return 60;
}

export function minuteTicks(fromMin: number, toMin: number): number[] {
  const step = tickStep(toMin - Math.max(0, fromMin));
  const out: number[] = [];
  for (let m = 0; m <= toMin; m += step) if (m >= fromMin) out.push(m);
  return out;
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export function linePath(points: readonly Pt[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${fmt(p.x)},${fmt(p.y)}`).join(" ");
}

/** The line closed down to the baseline, for the filled area under it. */
export function areaPath(points: readonly Pt[], baseY: number): string {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${fmt(last.x)},${fmt(baseY)} L${fmt(first.x)},${fmt(baseY)} Z`;
}

export function columnStartMin(axis: EngagementAxis, i: number): number {
  return axis.startMin + i * axis.bucketMin;
}

/** Header labels for the attendee heatmap: "Lobby" over the first lobby column, then sparse minutes. */
export function columnLabels(axis: EngagementAxis): string[] {
  const span = axis.columns * axis.bucketMin + Math.min(0, axis.startMin);
  const every = tickStep(span);
  return Array.from({ length: axis.columns }, (_, i) => {
    if (i < axis.lobbyColumns) return i === 0 ? "Lobby" : "";
    const m = columnStartMin(axis, i);
    return m % every === 0 ? `${m}m` : "";
  });
}

export function minuteLabel(m: number): string {
  return m < 0 ? `−${-m}m` : `${m}m`;
}

export function joinLabel(m: number): string {
  return m < 0 ? `${-m}m early` : `${m}m`;
}

export function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** Index of the nearest sample to a pointer position, for chart hover. */
export function nearestIndex(values: readonly number[], target: number): number {
  let best = -1;
  let dist = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < dist) {
      best = i;
      dist = d;
    }
  });
  return best;
}

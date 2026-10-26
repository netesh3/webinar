import type { AdminPoolBox } from "./api-types";

/* The admin's view of the video server pool (GET /api/admin/sfu-pool; api/internal/api/sfu_pool.go).
 * Points are the capacity model's estimates, so the percentage is "how full by the model", not a
 * CPU reading. */

/** How full a box is, 0–100+ (it can be over: a full region still takes a session). */
export function poolPercent(box: Pick<AdminPoolBox, "used" | "capacity">): number {
  if (box.capacity <= 0) return 0;
  return Math.round((box.used / box.capacity) * 100);
}

/** The tone of the meter: fine, nearly full (80%+), over. */
export function poolTone(box: Pick<AdminPoolBox, "used" | "capacity">): "ok" | "warn" | "over" {
  const pct = poolPercent(box);
  if (pct > 100) return "over";
  if (pct >= 80) return "warn";
  return "ok";
}

/** A box's state in words. */
export function poolStateLabel(actual: string): string {
  switch (actual) {
    case "ready":
      return "Up";
    case "draining":
      return "Up (draining)";
    case "creating":
    case "booting":
      return "Starting";
    case "deleting":
      return "Stopping";
    case "failed":
      return "Failed";
    default:
      return "Off";
  }
}

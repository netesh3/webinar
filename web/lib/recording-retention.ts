/* Cloud recording retention copy and the storage meter. Matches RECORDINGS_RETENTION_DAYS
 * (default 30) and the rules in api/internal/api/recording_retention.go.
 *
 * Free of React and the DOM so it runs in the plain node test beside it:
 *   node --experimental-strip-types --no-warnings lib/recording-retention.test.mts
 */

export const DEFAULT_RECORDING_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

export function recordingRetentionDays(
  rec?: { retentionDays?: number },
  fromConfig?: number,
): number {
  if (typeof rec?.retentionDays === "number") return rec.retentionDays;
  if (typeof fromConfig === "number") return fromConfig;
  return DEFAULT_RECORDING_RETENTION_DAYS;
}

/** Whole days until expiresAt, rounded up (so "today" is 0 only once it has passed). */
export function daysUntilExpiry(expiresAt?: string, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / DAY_MS);
}

/** "Deletes today", "1 day left", "12 days left". */
export function daysLeftText(days: number): string {
  if (days <= 0) return "Deletes today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/** The badge tone for a recording `days` from deletion: warn inside a week. */
export function expiryTone(days: number | null): "warn" | "neutral" {
  return days !== null && days <= 7 ? "warn" : "neutral";
}

export function retentionNotice(days: number): string {
  return `Cloud recordings are stored for ${days} days, then deleted automatically. Keep one longer, or download a copy to this computer if you need it after that.`;
}

/** A byte count as the meter says it: "6.2 GB", "10 GB", "0.4 GB". */
export function gbText(bytes: number): string {
  const gb = Math.max(0, bytes) / GB;
  if (gb >= 10 || Number.isInteger(gb)) return `${Math.round(gb)} GB`;
  return `${Math.round(gb * 10) / 10} GB`;
}

export type StorageMeter = {
  /** 0-100 for the bar (over quota shows full). */
  percent: number;
  /** "6.2 of 10 GB". */
  label: string;
  tone: "ok" | "warn" | "over";
};

/** The recording storage meter: used of quota, warn from 90%, over past 100%. */
export function storageMeter(used: number, quota: number): StorageMeter {
  const label = `${gbText(used).replace(/ GB$/, "")} of ${gbText(quota)}`;
  if (quota <= 0) return { percent: 100, label, tone: "over" };
  const ratio = used / quota;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const tone = ratio > 1 ? "over" : ratio >= 0.9 ? "warn" : "ok";
  return { percent, label, tone };
}

/** GB typed in an admin field to bytes, or null for "use the plan" (blank), or undefined
 *  when the text is not a usable number. */
export function parseQuotaGB(text: string, maxGB: number): number | null | undefined {
  const v = text.trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > maxGB) return undefined;
  return Math.round(n * GB);
}

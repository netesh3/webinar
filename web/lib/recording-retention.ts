/** Cloud recording retention copy. Matches RECORDINGS_RETENTION_DAYS (default 30). */

export const DEFAULT_RECORDING_RETENTION_DAYS = 30;

export function recordingRetentionDays(
  rec?: { retentionDays?: number },
  fromConfig?: number,
): number {
  if (typeof rec?.retentionDays === "number") return rec.retentionDays;
  if (typeof fromConfig === "number") return fromConfig;
  return DEFAULT_RECORDING_RETENTION_DAYS;
}

export function daysUntilExpiry(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
}

export function retentionNotice(days: number): string {
  return `Cloud recordings are stored for ${days} days, then deleted automatically. Download a copy to this computer if you need it after that.`;
}

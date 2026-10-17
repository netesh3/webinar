import type { AdminWhatsAppUsageSummary } from "./api-types";

/** The admin dashboard's one-line read of the WhatsApp usage summary. */
export function whatsAppUsageLine(s: AdminWhatsAppUsageSummary): string {
  if (s.hosts === 0) return "No hosts on WhatsApp yet.";
  const parts = [
    `${s.remindersOnly} reminders only`,
    `${s.usedCrm} used CRM features`,
  ];
  if (s.inactive > 0) parts.push(`${s.inactive} sent nothing`);
  return `${s.hosts} host${s.hosts === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** "3 of 12 (25%)" for one feature's share of hosts. */
export function featureShare(used: number, hosts: number): string {
  if (hosts === 0) return "0";
  return `${used} of ${hosts} (${Math.round((used / hosts) * 100)}%)`;
}

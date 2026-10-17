import {
  ImportFieldEmail,
  ImportFieldLastTransaction,
  ImportFieldName,
  ImportFieldPaymentCycle,
  ImportFieldPhone,
  ImportFieldService,
  ImportFieldSubscriptionExpiry,
} from "../lib/api-types.ts";

/* The CSV importer's pure rules: which fields a column can fill, whether a mapping
 * can be committed, and the default list name. The server re-checks all of it. */

export const IMPORT_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Don't import" },
  { value: ImportFieldName, label: "Name" },
  { value: ImportFieldPhone, label: "Phone (WhatsApp)" },
  { value: ImportFieldEmail, label: "Email" },
  { value: ImportFieldService, label: "Service / course (becomes a tag)" },
  { value: ImportFieldPaymentCycle, label: "Payment cycle" },
  { value: ImportFieldLastTransaction, label: "Last transaction date" },
  { value: ImportFieldSubscriptionExpiry, label: "Subscription expiry date" },
];

/** Why a mapping can't be imported yet, or null when it can. */
export function mappingProblem(mapping: string[]): string | null {
  const used = new Set<string>();
  for (const f of mapping) {
    if (!f) continue;
    if (used.has(f)) {
      const label = IMPORT_FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f;
      return `Two columns are both set to "${label}". Pick one.`;
    }
    used.add(f);
  }
  if (!used.has(ImportFieldPhone)) return "Choose which column has the phone numbers.";
  return null;
}

/** Changes one column's field; another column that had that field goes back to ignored. */
export function setColumnField(mapping: string[], index: number, field: string): string[] {
  return mapping.map((f, i) => (i === index ? field : field && f === field ? "" : f));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** "<file name> · 17 Oct 2026", matching the server's default. */
export function defaultListName(fileName: string, now: Date): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim() || "Imported contacts";
  return `${base} · ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

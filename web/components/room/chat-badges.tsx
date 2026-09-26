import type { Sender } from "@/lib/realtime";
import { LockIcon } from "../icons";

/* The small pills chat draws beside a name. Shared by the panel and the
 * notification card so a host looks the same in both. */

export function RoleBadge({ role }: { role: Sender["role"] }) {
  if (role === "attendee") return null;
  return role === "host" ? (
    <span className="shrink-0 rounded-full border border-brand-line bg-brand-soft px-1.5 text-[10px] leading-4 font-semibold text-brand">
      Host
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-line-2 bg-surface-2 px-1.5 text-[10px] leading-4 font-semibold text-ink-2">
      Panelist
    </span>
  );
}

export function PanelistsOnlyBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px] rounded-full border border-warn/25 bg-warn-soft px-1.5 text-[10px] leading-4 font-semibold text-warn">
      <LockIcon className="size-2.5" aria-hidden />
      Panelists only
    </span>
  );
}

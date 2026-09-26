import type { Sender } from "@/lib/realtime";
import { LockIcon } from "../icons";

/* The small pills the room draws beside a name. Shared by chat, the chat
 * notification card, Q&A and the participants list, so a host looks the same
 * in all four. */

const PILL = "shrink-0 rounded-full border px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap";
const STAGE_TONE = "border-brand-line bg-brand-soft text-brand";
const NEUTRAL_TONE = "border-line-2 bg-surface-2 text-ink-2";
const WARN_TONE = "border-warn/25 bg-warn-soft text-warn";
const TONES = { stage: STAGE_TONE, neutral: NEUTRAL_TONE, warn: WARN_TONE };

export function RoleBadge({ role }: { role: Sender["role"] }) {
  if (role === "attendee") return null;
  return role === "host" ? <Pill tone="stage">Host</Pill> : <Pill>Panelist</Pill>;
}

/** A role pill with a label of its own — "Co-host", "Speaker" — in the same two
 *  tones as RoleBadge: brand for people who run the room, neutral otherwise.
 *  Warn is for a state worth noticing, such as attendee chat being off. */
export function Pill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "stage" | "neutral" | "warn";
  className?: string;
}) {
  return <span className={`${PILL} ${TONES[tone]} ${className}`}>{children}</span>;
}

export function PanelistsOnlyBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px] rounded-full border border-warn/25 bg-warn-soft px-1.5 text-[10px] leading-4 font-semibold text-warn">
      <LockIcon className="size-2.5" aria-hidden />
      Panelists only
    </span>
  );
}

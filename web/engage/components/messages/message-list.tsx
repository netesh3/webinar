"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MaterialIcon } from "@/components/icons";
import type { CRMRecipe, MessageSlot } from "@/lib/api-types";
import { ENGAGE_HOME } from "../../slots";
import {
  MESSAGE_ROWS,
  rowWhen,
  unconfigured,
  type MessageGroup,
} from "./catalog";
import { ChannelBadges } from "./channel-badges";
import { MessageRow } from "./message-row";

/* Every attendee message, grouped Before / After / Automations.
 * Automations are the keyword and hot-lead rules, not the follow-ups —
 * those are rows in After. */

function ruleCopy(recipe: CRMRecipe): { title: string; then: string } {
  if (recipe.kind === "hot_leads") {
    const words = (recipe.words ?? []).slice(0, 3).join(", ");
    return {
      title: `When a reply mentions ${words || "price, program or 1:1"}`,
      then: "tag Hot lead",
    };
  }
  const first = recipe.keywords?.[0];
  if (first) {
    return {
      title: `When someone answers “${first.word}”`,
      then: first.reply ? `send ${first.reply}` : "send your reply",
    };
  }
  const steps = recipe.flow.filter((_, index) => index % 2 === 1);
  return {
    title: "When someone sends a keyword",
    then: steps.join(" · ") || "reply automatically",
  };
}

function GroupLabel({ label, count }: { label: string; count: string }) {
  return (
    <div className="flex items-baseline justify-between px-3 pt-3 pb-1">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        {label}
      </span>
      <span className="text-[11px] text-ink-3">{count}</span>
    </div>
  );
}

export function MessageList({
  slots,
  selected,
  automations,
  onSelect,
  onToggle,
  onToggleAutomation,
}: {
  slots: MessageSlot[];
  selected: string;
  automations: CRMRecipe[];
  onSelect: (kind: string) => void;
  onToggle: (kind: string, on: boolean) => void;
  onToggleAutomation: (recipe: CRMRecipe, on: boolean) => void;
}) {
  const router = useRouter();
  const byKind = new Map(slots.map((slot) => [slot.kind, slot]));
  const groups: { id: MessageGroup; label: string }[] = [
    { id: "before", label: "Before" },
    { id: "after", label: "After" },
  ];
  const autosOn = automations.filter((recipe) => recipe.active).length;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {groups.map((group) => {
        const rows = MESSAGE_ROWS.filter((row) => row.group === group.id);
        const on = rows.filter((row) => byKind.get(row.kind)?.enabled).length;
        const count =
          group.id === "after" ? `${on} of ${rows.length}` : String(on);
        return (
          <div key={group.id} className="border-b border-line">
            <GroupLabel label={group.label} count={count} />
            {rows.map((meta) => {
              const slot = byKind.get(meta.kind);
              const bare = unconfigured(slot);
              return (
                <MessageRow
                  key={meta.kind}
                  icon={meta.icon}
                  title={meta.title}
                  when={rowWhen(slot, meta)}
                  selected={selected === meta.kind}
                  dim={!slot?.enabled || bare}
                  enabled={Boolean(slot?.enabled)}
                  switchLabel={`${meta.title} for this webinar`}
                  onSelect={() => onSelect(meta.kind)}
                  onToggle={(next) => {
                    onSelect(meta.kind);
                    onToggle(meta.kind, next);
                  }}
                  badges={<ChannelBadges channels={slot?.channels ?? []} />}
                />
              );
            })}
          </div>
        );
      })}

      <div>
        <GroupLabel
          label="Automations"
          count={automations.length === 0 ? "—" : `${autosOn} on`}
        />
        {automations.map((recipe) => {
          const copy = ruleCopy(recipe);
          return (
            <MessageRow
              key={recipe.id}
              icon={recipe.kind === "hot_leads" ? "sell" : "poll"}
              title={
                <>
                  <span className="font-medium text-ink-3">When </span>
                  {copy.title.replace(/^When /i, "")}
                </>
              }
              when={
                <span className="inline-flex items-center gap-1">
                  <MaterialIcon name="arrow_forward" className="size-[13px] shrink-0" />
                  {copy.then}
                </span>
              }
              enabled={recipe.active}
              switchLabel={recipe.title}
              onSelect={() => router.push(ENGAGE_HOME)}
              onToggle={(on) => onToggleAutomation(recipe, on)}
              trailing={
                <Link
                  href={ENGAGE_HOME}
                  aria-label={`Open ${recipe.title} on the WhatsApp page`}
                  className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MaterialIcon name="chevron_right" className="size-[18px]" />
                </Link>
              }
            />
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-[12.5px]">
          <Link
            href={ENGAGE_HOME}
            className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
          >
            <MaterialIcon name="add" className="size-[15px] shrink-0" />
            New automation
          </Link>
          <Link
            href={ENGAGE_HOME}
            className="inline-flex items-center gap-1 text-ink-2 hover:text-ink hover:underline"
          >
            All automations on the WhatsApp page
            <MaterialIcon name="arrow_forward" className="size-[15px] shrink-0" />
          </Link>
        </div>
      </div>
    </div>
  );
}

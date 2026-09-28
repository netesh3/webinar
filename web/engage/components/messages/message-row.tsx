"use client";

import type { ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import { Switch } from "../wa-kit";

/* One message: icon, name and when, then three fixed slots — badges, switch, chevron —
 * so the switches in a group sit on one vertical line. The name is the button that
 * opens the pane; the switch and a Choose a message button stay outside it. */

export function MessageRow({
  icon,
  title,
  when,
  selected,
  dim,
  enabled,
  switchLabel,
  onSelect,
  onToggle,
  badges,
  trailing,
}: {
  icon: string;
  title: ReactNode;
  when: ReactNode;
  selected?: boolean;
  dim?: boolean;
  enabled?: boolean;
  switchLabel?: string;
  onSelect: () => void;
  onToggle?: (on: boolean) => void;
  badges?: ReactNode;
  /** Replaces the chevron. Automations use a link. */
  trailing?: ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-[1.75rem_minmax(0,1fr)_8.75rem_2rem_1.25rem] items-center gap-x-2 px-3 py-1 ${
        selected ? "bg-brand-soft" : ""
      } ${dim ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="col-span-2 flex min-w-0 items-center gap-2 rounded-lg py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
      >
        <MaterialIcon name={icon} className="size-5 text-ink-3" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-ink">
            {title}
          </span>
          <span className="block truncate text-[11.5px] font-normal text-ink-3">
            {when}
          </span>
        </span>
      </button>
      <div className="flex min-w-0 justify-end py-1.5">{badges}</div>
      <div className="flex justify-center">
        {onToggle && switchLabel ? (
          <Switch
            checked={Boolean(enabled)}
            onChange={onToggle}
            label={switchLabel}
          />
        ) : null}
      </div>
      <div className="text-ink-3">
        {trailing ?? (
          <button
            type="button"
            onClick={onSelect}
            aria-label={switchLabel ? `Open ${switchLabel}` : "Open"}
            className="grid size-7 place-items-center rounded-md hover:bg-surface-2"
          >
            <MaterialIcon name="chevron_right" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

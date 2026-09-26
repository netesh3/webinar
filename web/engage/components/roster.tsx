"use client";

import { useState, type ReactNode } from "react";
import { useSession } from "@/components/providers";
import { Button } from "@/components/ui";
import { SendIcon } from "@/components/icons";
import type { CRMSegment, RegistrantRow } from "@/lib/api-types";
import { SendDialog, type SendTarget } from "./send-dialog";

/* The Attendees tab's messaging: tick rows, "Message these N", and the send dialog.
 *
 * A hook that hands back pieces rather than a component, because the table is the
 * webinar's: it decides the columns and the rows (including which watch-time chip is
 * active), and asks this for a checkbox cell, the bar above it, and the dialog. With
 * nothing ticked, "these N" is the chip the host is looking at — sent as a segment, so
 * the server resolves the same people. With rows ticked it is exactly those people.
 */
export function useRosterMessaging({
  webinarId,
  rows,
  bucket,
}: {
  webinarId: string;
  /** The rows on screen, after the chip. */
  rows: RegistrantRow[];
  /** The chip, as a segment and in words; null for everyone. */
  bucket: { segment: CRMSegment; label: string } | null;
}) {
  const { account } = useSession();
  const enabled = Boolean(account?.whatsapp);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<SendTarget | null>(null);

  const messageable = rows.filter((r) => r.contactId);
  const onScreen = new Set(messageable.map((r) => r.contactId!));
  const picked = [...ticked].filter((id) => onScreen.has(id));
  const allTicked = messageable.length > 0 && picked.length === messageable.length;

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function open() {
    if (picked.length > 0) {
      setTarget({
        kind: "contacts",
        contactIds: picked,
        webinarId,
        label: `${picked.length} ${picked.length === 1 ? "person" : "people"} you picked`,
      });
    } else {
      setTarget({
        kind: "segment",
        webinarId,
        segment: bucket?.segment ?? {},
        label: bucket?.label ?? "Everyone registered",
      });
    }
  }

  const n = picked.length > 0 ? picked.length : rows.length;

  const headerCell: ReactNode = enabled ? (
    <th className="w-8 py-2 pr-2">
      <input
        type="checkbox"
        aria-label="Tick everyone shown"
        className="size-3.5 accent-brand"
        checked={allTicked}
        onChange={() =>
          setTicked(allTicked ? new Set() : new Set(messageable.map((r) => r.contactId!)))
        }
      />
    </th>
  ) : null;

  const cell = (row: RegistrantRow): ReactNode =>
    enabled ? (
      <td className="py-2.5 pr-2">
        {row.contactId && (
          <input
            type="checkbox"
            aria-label={`Tick ${row.name}`}
            className="size-3.5 accent-brand"
            checked={ticked.has(row.contactId)}
            onChange={() => toggle(row.contactId!)}
          />
        )}
      </td>
    ) : null;

  const bar: ReactNode =
    enabled && rows.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        {picked.length > 0 && (
          <button
            type="button"
            onClick={() => setTicked(new Set())}
            className="text-[12px] text-ink-2 hover:text-ink"
          >
            Clear {picked.length} ticked
          </button>
        )}
        <Button size="sm" onClick={open}>
          <SendIcon className="size-3.5" />
          Message {picked.length > 0 ? "these" : "all"} {n}
        </Button>
      </div>
    ) : null;

  const dialog: ReactNode = (
    <SendDialog
      open={target !== null}
      target={target}
      onClose={() => setTarget(null)}
      onSent={() => setTicked(new Set())}
    />
  );

  return { enabled, headerCell, cell, bar, dialog };
}

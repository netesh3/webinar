"use client";

import type { Ref } from "react";
import {
  ScheduleMessagesTab,
  type MessagesSaveHandle,
  type MessagesSummary,
  type PreviewWebinar,
} from "@/engage";
import type { MessageSlot } from "@/lib/api-types";
import { ReminderTimes } from "../reminder-times";

/* Messages & follow-ups.
 *
 * The editor is the engage slot, the same one an existing webinar's Setup tab
 * uses. Reminder times are this form's control, passed in so engage does not
 * import a webinar screen. */
export function MessagesTab({
  previewWebinar,
  slug,
  saveRef,
  onSummary,
  onLoadError,
  initialPending,
  onPendingChange,
}: {
  previewWebinar: PreviewWebinar;
  slug?: string;
  saveRef?: Ref<MessagesSaveHandle>;
  /** How many messages are on, and whether this webinar changed them. */
  onSummary?: (summary: MessagesSummary) => void;
  onLoadError?: () => void;
  initialPending?: MessageSlot[];
  onPendingChange?: (slots: MessageSlot[]) => void;
}) {
  return (
    <ScheduleMessagesTab
      ref={saveRef}
      slug={slug}
      webinar={previewWebinar}
      onSummary={onSummary}
      onLoadError={onLoadError}
      initialPending={initialPending}
      onPendingChange={onPendingChange}
      reminderTimes={({ value, onChange, disabled }) => (
        <ReminderTimes value={value} onChange={onChange} disabled={disabled} />
      )}
    />
  );
}

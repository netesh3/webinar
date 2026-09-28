"use client";

import type { Ref } from "react";
import {
  ScheduleMessagesTab,
  type MessagesSaveHandle,
  type PreviewWebinar,
} from "@/engage";
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
}: {
  previewWebinar: PreviewWebinar;
  slug?: string;
  saveRef?: Ref<MessagesSaveHandle>;
}) {
  return (
    <ScheduleMessagesTab
      ref={saveRef}
      slug={slug}
      webinar={previewWebinar}
      reminderTimes={({ value, onChange, disabled }) => (
        <ReminderTimes value={value} onChange={onChange} disabled={disabled} />
      )}
    />
  );
}

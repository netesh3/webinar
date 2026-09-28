"use client";

import {
  AttendeeMessages,
  WhatsAppRemindersToggle,
  type PreviewWebinar,
} from "@/engage";
import { Toggle } from "../controls";
import {
  DEFAULT_REMINDERS,
  describeReminders,
  ReminderTimes,
} from "../reminder-times";
import { Boxed, FormGroup, FormSection } from "./chrome";
import type { FormState, SetForm } from "./form-state";

/* Messages & follow-ups.
 *
 * The list itself is the engage slot. Phase 3 replaces AttendeeMessages with
 * ScheduleMessagesTab; until then the reminder switches stay here, because they
 * are still the fields this form saves. */
export function MessagesTab({
  form,
  set,
  fields,
  previewWebinar,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  previewWebinar: PreviewWebinar;
}) {
  return (
    <div className="grid gap-5">
      <FormGroup label="Reminders">
        <FormSection
          title="Reminders"
          first
          description="The same times drive email and WhatsApp."
        >
          <div className="grid gap-3.5">
            <div className="grid gap-2.5 lg:grid-cols-2">
              <Boxed
                on={Boolean(form.options.emailReminders)}
                className="lg:only:col-span-2"
              >
                <Toggle
                  checked={Boolean(form.options.emailReminders)}
                  onChange={(v) =>
                    set("options", { ...form.options, emailReminders: v })
                  }
                  label="Email reminders"
                />
              </Boxed>
              <WhatsAppRemindersToggle
                boxed
                checked={Boolean(form.options.whatsappReminders)}
                onChange={(v) =>
                  set("options", { ...form.options, whatsappReminders: v })
                }
              />
            </div>
            <ReminderTimes
              value={form.options.reminders}
              onChange={(r) =>
                set("options", { ...form.options, reminders: r })
              }
              disabled={
                !form.options.emailReminders && !form.options.whatsappReminders
              }
            />
            {fields.reminders && (
              <p className="text-[12px] font-medium text-live">
                {fields.reminders}
              </p>
            )}
          </div>
        </FormSection>
      </FormGroup>

      <FormGroup label="What attendees get">
        <FormSection
          title="Before"
          description="From the moment they register until you go live."
          first
        >
          <AttendeeMessages
            stage="before"
            webinar={previewWebinar}
            email={Boolean(form.options.emailReminders)}
            whatsapp={Boolean(form.options.whatsappReminders)}
            reminderLabel={describeReminders(
              form.options.reminders ?? DEFAULT_REMINDERS,
            )}
          />
        </FormSection>
        <FormSection
          title="After"
          description="The replay, and a follow-up for each engagement group."
        >
          <AttendeeMessages
            stage="after"
            webinar={previewWebinar}
            email
            whatsapp={Boolean(form.options.whatsappReminders)}
            reminderLabel=""
          />
        </FormSection>
      </FormGroup>
    </div>
  );
}

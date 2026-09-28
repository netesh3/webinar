"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { engageApi } from "../../api";
import { Alert, Modal, Spinner } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { ApiError } from "@/lib/api";
import {
  SlotReminder,
  type CRMMergeField,
  type CRMRecipe,
  type CRMTemplate,
  type MessageSlot,
  type WebinarOptions,
} from "@/lib/api-types";
import type { PreviewWebinar } from "../schedule-messages";
import { StarterTemplates } from "../starter-templates";
import {
  clearPatch,
  legacyOptions,
  normalizeSlots,
  slotReady,
  toPatch,
  unconfigured,
} from "./catalog";
import { MessageList } from "./message-list";
import { MessagePane, type ReminderTimesEditor } from "./message-pane";

/* Messages & follow-ups: the list and the pane, reading and writing slots.
 *
 * With a webinar slug, a change is saved at once — to the account defaults when
 * "Use this for all my webinars" is ticked, otherwise as this webinar's override.
 * While a webinar is still being scheduled, overrides wait in persistOverrides
 * until the form has a slug to attach them to. Defaults are written immediately
 * either way, because they are not tied to one webinar. */

export type MessagesSaveHandle = {
  /** Write per-webinar overrides that were edited before this webinar existed. */
  persistOverrides: (slug: string) => Promise<void>;
};

export type { PreviewWebinar, ReminderTimesEditor };

export const ScheduleMessagesTab = forwardRef<
  MessagesSaveHandle,
  {
    /** Set once the webinar exists. Absent on the schedule form until save. */
    slug?: string;
    webinar?: PreviewWebinar;
    reminderTimes: ReminderTimesEditor;
    /** Keeps the schedule form's reminder options in step with the slots it saves. */
    onLegacyOptions?: (patch: Partial<WebinarOptions>) => void;
  }
>(function ScheduleMessagesTab(
  { slug, webinar, reminderTimes, onLegacyOptions },
  ref,
) {
  const { account } = useSession();
  const { notify } = useToast();
  const connected = Boolean(account?.whatsapp?.connected);
  const coachName = account?.whatsapp?.verifiedName || account?.name || "You";
  const [slots, setSlots] = useState<MessageSlot[] | null>(null);
  const [templates, setTemplates] = useState<CRMTemplate[]>([]);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [automations, setAutomations] = useState<CRMRecipe[]>([]);
  const [selected, setSelected] = useState(SlotReminder);
  const [forAll, setForAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [tick, setTick] = useState(0);
  const pending = useRef(new Map<string, MessageSlot>());
  const onLegacy = useRef(onLegacyOptions);
  onLegacy.current = onLegacyOptions;

  const [picked, setPicked] = useState(selected);
  if (picked !== selected) {
    setPicked(selected);
    setForAll(false);
  }

  useImperativeHandle(ref, () => ({
    persistOverrides: async (nextSlug: string) => {
      const waiting = [...pending.current.values()];
      if (waiting.length === 0) return;
      await engageApi.setWebinarMessageSlots(nextSlug, {
        slots: waiting.map(toPatch),
      });
      pending.current.clear();
    },
  }));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      engageApi.messageDefaults(),
      slug
        ? engageApi.crmWebinarMessages(slug).catch(() => null)
        : Promise.resolve(null),
      engageApi.crmTemplates().catch(() => ({ templates: [] as CRMTemplate[] })),
      engageApi.crmReminders().catch(() => null),
      engageApi.crmRecipes().catch(() => null),
    ])
      .then(([defaults, webinarMessages, templateList, reminders, recipes]) => {
        if (cancelled) return;
        const next = normalizeSlots(
          webinarMessages?.slots?.length ? webinarMessages.slots : defaults.slots,
        );
        setSlots(next);
        onLegacy.current?.(legacyOptions(next));
        setTemplates(templateList.templates ?? []);
        setFields(reminders?.fields ?? []);
        setAutomations(
          (recipes?.recipes ?? []).filter(
            (recipe) => recipe.kind === "keywords" || recipe.kind === "hot_leads",
          ),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load messages.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, tick]);

  const previewFields = useMemo(
    () => withWebinar(fields, webinar),
    [fields, webinar],
  );

  const applyLocal = useCallback((next: MessageSlot) => {
    setSlots((current) =>
      (current ?? []).map((slot) => (slot.kind === next.kind ? next : slot)),
    );
  }, []);

  const commit = useCallback(
    async (next: MessageSlot, asDefault: boolean) => {
      const problem = slotReady(next);
      if (problem) {
        notify(problem, "error");
        return;
      }
      const previous = slots;
      const list = (slots ?? []).map((slot) =>
        slot.kind === next.kind ? next : slot,
      );
      applyLocal(next);
      onLegacy.current?.(legacyOptions(list));
      try {
        if (asDefault) {
          await engageApi.setMessageDefaults({ slots: [next] });
          pending.current.delete(next.kind);
          if (slug) {
            const saved = await engageApi.setWebinarMessageSlots(slug, {
              slots: [clearPatch(next.kind)],
            });
            setSlots(normalizeSlots(saved.slots));
            onLegacy.current?.(legacyOptions(normalizeSlots(saved.slots)));
          }
          return;
        }
        if (slug) {
          const saved = await engageApi.setWebinarMessageSlots(slug, {
            slots: [toPatch(next)],
          });
          pending.current.delete(next.kind);
          setSlots(normalizeSlots(saved.slots));
          onLegacy.current?.(legacyOptions(normalizeSlots(saved.slots)));
          return;
        }
        pending.current.set(next.kind, next);
      } catch (err) {
        setSlots(previous);
        if (previous) onLegacy.current?.(legacyOptions(previous));
        notify(
          err instanceof ApiError ? err.message : "Could not save that message.",
          "error",
        );
      }
    },
    [applyLocal, notify, slug, slots],
  );

  async function toggleAutomation(recipe: CRMRecipe, on: boolean) {
    if (on && recipe.kind === "keywords" && !recipe.configured) {
      notify("Set the replies up on the WhatsApp page, then switch it on.", "info");
      return;
    }
    try {
      const saved = await engageApi.saveCrmRecipe(recipe.id, {
        active: on,
        keywords: recipe.kind === "keywords" ? recipe.keywords : undefined,
        words: recipe.kind === "hot_leads" ? recipe.words : undefined,
      });
      setAutomations(
        saved.recipes.filter(
          (item) => item.kind === "keywords" || item.kind === "hot_leads",
        ),
      );
      notify(on ? `${recipe.title} is on.` : `${recipe.title} is off.`, "ok");
    } catch (err) {
      notify(
        err instanceof ApiError ? err.message : "Could not change that automation.",
        "error",
      );
    }
  }

  function select(kind: string) {
    setSelected(kind);
    const slot = slots?.find((item) => item.kind === kind);
    if (unconfigured(slot)) {
      requestAnimationFrame(() => {
        document.getElementById("message-wording")?.scrollIntoView({
          block: "nearest",
        });
      });
    }
  }

  if (error && !slots) return <Alert tone="error">{error}</Alert>;
  if (!slots) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const slot = slots.find((item) => item.kind === selected) ?? slots[0];
  const when = webinar?.startsAt
    ? whenText(webinar.startsAt, webinar.timeZone)
    : "";

  return (
    <div className="grid gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.9fr)]">
      <MessageList
        slots={slots}
        selected={slot?.kind ?? selected}
        automations={automations}
        onSelect={select}
        onToggle={(kind, on) => {
          const current = slots.find((item) => item.kind === kind);
          if (current) void commit({ ...current, enabled: on }, forAll && kind === slot?.kind);
        }}
        onToggleAutomation={(recipe, on) => void toggleAutomation(recipe, on)}
      />
      {slot && (
        <MessagePane
          key={slot.kind}
          slot={slot}
          fields={previewFields}
          templates={templates}
          connected={connected}
          coachName={coachName}
          topic={webinar?.topic ?? ""}
          whenText={when}
          forAll={forAll}
          reminderTimes={reminderTimes}
          onChange={(next) => void commit(next, forAll)}
          onForAll={(on) => {
            setForAll(on);
            if (on) void commit(slot, true);
          }}
          onWriteOwn={() => setWriting(true)}
        />
      )}
      {writing &&
        createPortal(
          <Modal
            open
            onClose={() => setWriting(false)}
            size="lg"
            title="Write your own wording"
          >
            <div className="grid gap-3">
              <Alert tone="info">
                Meta approves every message before it can be sent, usually in
                minutes. Start from these, written for webinars.
              </Alert>
              <StarterTemplates
                connected={connected}
                onCreated={() => setTick((n) => n + 1)}
              />
            </div>
          </Modal>,
          document.body,
        )}
      </div>
    </div>
  );
});

/* The server's "when" format — notify.LocalTime: "14:00 on 14 October 2026 IST". */
function whenText(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZoneName: "short",
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("hour")}:${get("minute")} on ${get("day")} ${get("month")} ${get("year")} ${get("timeZoneName")}`;
  } catch {
    return "";
  }
}

/** The host's merge-field examples, with this webinar's title and time over them. */
function withWebinar(
  hostFields: CRMMergeField[],
  webinar: PreviewWebinar | undefined,
): CRMMergeField[] {
  if (!webinar) return hostFields;
  const when = webinar.startsAt ? whenText(webinar.startsAt, webinar.timeZone) : "";
  const slug = webinar.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return hostFields.map((field) =>
    field.token === "topic" && webinar.topic.trim()
      ? { ...field, example: webinar.topic.trim() }
      : field.token === "when" && when
        ? { ...field, example: when }
        : field.token === "replay" && slug
          ? {
              ...field,
              example: field.example.replace(
                /\/w\/[^/]+\/recording\//,
                `/w/${slug}/recording/`,
              ),
            }
          : field,
  );
}

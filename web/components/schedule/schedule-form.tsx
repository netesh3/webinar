"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Alert } from "../controls";
import { CheckIcon } from "../icons";
import { useAppConfig, useToast } from "../providers";
import { API_BASE, ApiError, api } from "@/lib/api";
import type { MessagesSaveHandle } from "@/engage";
import type { Webinar, WebinarInput } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { zonedToInstant } from "@/lib/format";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { useScheduleSurvey } from "../survey/schedule-survey";
import { ActionBar } from "./action-bar";
import { initialState, type FormState } from "./form-state";
import { MessagesTab } from "./messages-tab";
import { scheduleSummary, shortTimeZone } from "./summary";
import { WebinarTab } from "./webinar-tab";

export type { FormState };
export { DEFAULT_ATTENDEE_LIMIT } from "./form-state";

type Step = "webinar" | "messages";

const MESSAGE_FIELDS = new Set(["reminders"]);

function stepFrom(value: string | null): Step {
  return value === "messages" ? "messages" : "webinar";
}

function tabForFields(fields: Record<string, string>): Step {
  const keys = Object.keys(fields);
  if (keys.length > 0 && keys.every((k) => MESSAGE_FIELDS.has(k))) {
    return "messages";
  }
  return "webinar";
}

function anchorForFields(fields: Record<string, string>): string {
  const keys = Object.keys(fields);
  if (keys.includes("reminders")) return "settings-reminders";
  if (keys.some((k) => ["startsAt", "timeZone", "durationMin"].includes(k))) {
    return "settings-when";
  }
  if (
    keys.some((k) =>
      ["passcode", "approval", "customQuestions", "attendeeLimit"].includes(k),
    )
  ) {
    return "settings-registration";
  }
  if (keys.includes("panelistEmails")) return "settings-in-the-room";
  return "settings-the-basics";
}

function scrollToId(id: string) {
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}

export function ScheduleForm({ webinar = null }: { webinar?: Webinar | null }) {
  return (
    <Suspense fallback={<ScheduleFallback />}>
      <ScheduleFormBody webinar={webinar} />
    </Suspense>
  );
}

function ScheduleFallback() {
  return (
    <div className="grid gap-5 pb-48 lg:pb-24">
      <div className="h-4 w-80 animate-pulse rounded bg-surface-2" />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="h-[62px] animate-pulse rounded-xl bg-surface-2" />
        <div className="h-[62px] animate-pulse rounded-xl bg-surface-2" />
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

function ScheduleFormBody({ webinar = null }: { webinar?: Webinar | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const config = useAppConfig();
  const { notify } = useToast();
  const editing = webinar !== null;
  const fromUrl = stepFrom(search.get("step"));
  const [step, setStep] = useState<Step>(fromUrl);
  // The tab follows the URL, including Back. Comparing during render — rather
  // than in an effect — keeps a click instant and still picks up the address bar.
  const [urlStep, setUrlStep] = useState<Step>(fromUrl);
  if (fromUrl !== urlStep) {
    setUrlStep(fromUrl);
    setStep(fromUrl);
  }

  function go(next: Step) {
    setStep(next);
    const params = new URLSearchParams(search.toString());
    if (next === "messages") params.set("step", "messages");
    else params.delete("step");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const [form, setForm] = useState<FormState>(() =>
    initialState(webinar, config.maxAttendees),
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scheduled" | "draft" | null>(null);
  const messagesRef = useRef<MessagesSaveHandle>(null);
  const [messagesOn, setMessagesOn] = useState<number | null>(null);

  /* The cover image.
   *
   * Cropped and compressed entirely client-side (see webinar-image-picker.tsx)
   * the moment it is picked, but not uploaded until the webinar itself is saved
   * — a webinar being scheduled for the first time has no slug yet to upload
   * against, and uploading on pick for an EXISTING webinar while leaving the
   * option to cancel the rest of the form would save half an edit. `imageUrl`
   * mirrors what the preview shows: the persisted image to start with, a local
   * object URL once a new one is picked, or null with nothing shown. */
  const [imagePreview, setImagePreview] = useState<string | null>(
    webinar?.imageUrl ? `${API_BASE}${webinar.imageUrl}` : null,
  );
  const [pendingImage, setPendingImage] = useState<PreparedWebinarImage | null>(
    null,
  );
  // True once the host removes a PERSISTED image with no replacement chosen —
  // the thing submit() actually has to tell the server about. Picking a new
  // image after removing one clears this; the upload itself is the replacement.
  const [imageRemoved, setImageRemoved] = useState(false);

  const hydrated = useHydrated();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const survey = useScheduleSurvey(webinar, form.durationMin);

  function toInput(status: "scheduled" | "draft"): WebinarInput | null {
    const startsAt = zonedToInstant(form.date, form.time, form.timeZone);
    if (!startsAt) {
      setFields({ startsAt: "Pick a valid date and time." });
      flushSync(() => go("webinar"));
      scrollToId("settings-when");
      return null;
    }
    return {
      topic: form.topic,
      summary: form.summary,
      description: form.description,
      track: form.track.trim(),
      startsAt: startsAt.toISOString(),
      durationMin: form.durationMin,
      timeZone: form.timeZone,
      kind: form.kind,
      status,
      registrationRequired: form.registrationRequired,
      approval: form.approval,
      attendeeLimit: form.attendeeLimit,
      passcode: form.passcode.trim(),
      agenda: form.agenda,
      takeaways: form.takeaways
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
      customQuestions: form.questions.filter((q) => q.label.trim() !== ""),
      panelistEmails: form.panelistEmails
        .split(/[\n,;]/)
        .map((e) => e.trim())
        .filter(Boolean),
      // Mirrors whether a survey is set up, for the places that only read the webinar.
      options: { ...form.options, postWebinarSurvey: survey.on },
      controls: form.controls,
    };
  }

  async function submit(status: "scheduled" | "draft") {
    setBusy(status);
    setError(null);
    setFields({});

    const input = toInput(status);
    if (!input) {
      setBusy(null);
      return;
    }
    const surveyProblem = survey.problem();
    if (surveyProblem) {
      setError(surveyProblem);
      flushSync(() => go("webinar"));
      scrollToId("survey");
      setBusy(null);
      return;
    }

    try {
      let saved = editing
        ? await api.updateWebinar(webinar.id, input)
        : await api.createWebinar(input);

      /* The image, once the webinar itself has a slug to attach it to.
       *
       * Best-effort and after the fact, deliberately: the webinar is already
       * saved by this point, and failing the whole save over a cover image —
       * the one field on this form that is purely decorative — would be the
       * wrong trade. A failure here is a toast, not a blocked navigation. */
      if (pendingImage) {
        try {
          saved = await api.uploadWebinarImage(
            saved.id,
            pendingImage.blob,
            pendingImage.mime,
          );
        } catch {
          notify(
            "Saved, but the cover image didn't upload. Edit the webinar to try again.",
            "info",
          );
        }
      } else if (imageRemoved) {
        try {
          saved = await api.deleteWebinarImage(saved.id);
        } catch {
          notify(
            "Saved, but the cover image couldn't be removed. Edit the webinar to try again.",
            "info",
          );
        }
      }

      try {
        if (form.options.multistream) {
          if (form.streamKey || form.streamWatchUrl) {
            saved = await api.setWebinarStream(saved.id, {
              streamKey: form.streamKey,
              watchUrl: form.streamWatchUrl,
            });
          }
          // Connected YouTube with no pasted key: the live is created when
          // the webinar starts, so we do not mint a Studio event on every save.
        } else if (
          saved.streamConfigured ||
          saved.streamKeySaved ||
          saved.streamWatchUrl
        ) {
          saved = await api.setWebinarStream(saved.id, {
            off: true,
            dropWatch: true,
            streamKey: "",
            watchUrl: "",
          });
        }
      } catch (err) {
        notify(
          err instanceof Error
            ? `Saved the webinar, but YouTube streaming wasn't set: ${err.message}`
            : "Saved the webinar, but YouTube streaming wasn't set.",
          "info",
        );
      }

      const surveyWarning = await survey.persist(saved.id);
      if (surveyWarning) notify(surveyWarning, "info");

      try {
        await messagesRef.current?.persistOverrides(saved.id);
      } catch (err) {
        notify(
          err instanceof Error
            ? `Saved the webinar, but its messages weren't updated: ${err.message}`
            : "Saved the webinar, but its messages weren't updated.",
          "info",
        );
      }

      notify(
        editing
          ? "Changes saved."
          : status === "draft"
            ? "Saved as a draft."
            : "Webinar scheduled.",
        "ok",
      );
      router.push(`/host/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) {
          setFields(err.fields);
          const tab = tabForFields(err.fields);
          flushSync(() => go(tab));
          scrollToId(anchorForFields(err.fields));
        } else setError(err.message);
      } else {
        setError("Could not save. Check your connection and try again.");
      }
      setBusy(null);
    }
  }

  const startsAtPreview = useMemo(
    () => zonedToInstant(form.date, form.time, form.timeZone),
    [form.date, form.time, form.timeZone],
  );
  const previewWebinar = useMemo(
    () => ({
      topic: form.topic,
      startsAt: startsAtPreview,
      timeZone: form.timeZone,
    }),
    [form.topic, startsAtPreview, form.timeZone],
  );
  const summaryZone =
    hydrated && startsAtPreview && form.timeZone
      ? shortTimeZone(form.timeZone, startsAtPreview)
      : "";
  const summary = scheduleSummary(form, summaryZone);
  const showDraft = !editing || webinar.status === "draft";
  const webinarDone = step === "messages" && form.topic.trim() !== "";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        if (!formEl.checkValidity()) {
          const invalid = formEl.querySelector(":invalid");
          const tab =
            invalid instanceof HTMLElement &&
            invalid
              .closest("[data-schedule-tab]")
              ?.getAttribute("data-schedule-tab") === "messages"
              ? "messages"
              : "webinar";
          flushSync(() => go(tab));
          if (invalid instanceof HTMLElement) {
            invalid.focus();
            formEl.reportValidity();
          }
          return;
        }
        void submit("scheduled");
      }}
    >
      {/* The bar is position:fixed, so it does not take a row. This padding
          is what keeps the last fields from sitting underneath it. */}
      <div className="grid gap-5 pb-48 lg:pb-24">
        <p className="text-[13px] text-ink-2">
          Set up the webinar, then what your attendees get. You can change
          anything later.
        </p>

        {error && <Alert tone="error">{error}</Alert>}
        {!error && Object.keys(fields).length > 0 && (
          <Alert tone="error">{Object.values(fields).join(" ")}</Alert>
        )}

        <div
          role="tablist"
          aria-label="Schedule"
          className="grid gap-2.5 sm:grid-cols-2"
        >
          <TabButton
            selected={step === "webinar"}
            done={webinarDone}
            n="1"
            title="The webinar"
            detail={
              webinarDone && summary.lead
                ? `${form.topic} · ${summary.lead}`
                : "Title, time, registration, the room"
            }
            controls="schedule-panel-webinar"
            onClick={() => go("webinar")}
          />
          <TabButton
            selected={step === "messages"}
            n="2"
            title="Messages & follow-ups"
            detail={
              messagesOn == null
                ? "Reminders, WhatsApp, after it ends"
                : `Reminders, WhatsApp, after it ends · ${messagesOn} on`
            }
            controls="schedule-panel-messages"
            onClick={() => go("messages")}
          />
        </div>

        {/* Both panels stay mounted. Folding one with `hidden` keeps reminder
            editors and the survey builder from losing state, and a failed
            submit can still find the invalid field and open its tab. */}
        <div
          id="schedule-panel-webinar"
          role="tabpanel"
          aria-labelledby="schedule-tab-webinar"
          data-schedule-tab="webinar"
          className={step === "webinar" ? undefined : "hidden"}
        >
          <WebinarTab
            form={form}
            set={set}
            fields={fields}
            editing={editing}
            webinar={webinar}
            imagePreview={imagePreview}
            onImage={(prepared, preview) => {
              setPendingImage(prepared);
              setImageRemoved(false);
              setImagePreview(preview);
            }}
            onImageRemove={() => {
              setPendingImage(null);
              setImagePreview(null);
              // Only worth telling the server about if there was something
              // persisted to remove — a pending, never-uploaded selection being
              // cleared is not a change the webinar has ever seen.
              setImageRemoved(Boolean(webinar?.imageUrl));
            }}
            onMessages={() => go("messages")}
            survey={survey.node}
            messagesOn={messagesOn}
          />
        </div>
        <div
          id="schedule-panel-messages"
          role="tabpanel"
          aria-labelledby="schedule-tab-messages"
          data-schedule-tab="messages"
          className={step === "messages" ? undefined : "hidden"}
        >
          <MessagesTab
            previewWebinar={previewWebinar}
            slug={webinar?.id}
            saveRef={messagesRef}
            onEnabledCount={setMessagesOn}
          />
        </div>
      </div>

      <ActionBar
        lead={summary.lead}
        rest={summary.rest}
        editing={editing}
        showDraft={showDraft}
        busy={busy}
        onDraft={() => void submit("draft")}
      />
    </form>
  );
}

function TabButton({
  selected,
  done,
  n,
  title,
  detail,
  controls,
  onClick,
}: {
  selected: boolean;
  done?: boolean;
  n: string;
  title: string;
  detail: string;
  controls: string;
  onClick: () => void;
}) {
  const id = controls.replace("panel", "tab");
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={controls}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        selected
          ? "border-brand bg-surface shadow-[0_0_0_3px_rgba(11,92,255,0.12)]"
          : "border-line bg-surface hover:border-line-2"
      }`}
    >
      <span
        className={`grid size-[26px] shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
          done
            ? "bg-ok-soft text-ok"
            : selected
              ? "bg-brand text-white"
              : "bg-surface-2 text-ink-2"
        }`}
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-ink">
          {title}
        </span>
        <span className="mt-px block truncate text-[12px] text-ink-3">
          {detail}
        </span>
      </span>
    </button>
  );
}

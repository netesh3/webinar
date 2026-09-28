"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { Alert } from "../controls";
import { useAppConfig, useSession, useToast } from "../providers";
import { Button } from "../ui";
import { API_BASE, ApiError, api } from "@/lib/api";
import type { MessagesSaveHandle } from "@/engage";
import type { MessageSlot, Webinar, WebinarInput } from "@/lib/api-types";
import { useHydrated, useNow } from "@/lib/clock";
import { zonedToInstant } from "@/lib/format";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { useScheduleSurvey } from "../survey/schedule-survey";
import {
  ActionBar,
  type DraftStatus,
  type FollowUpSummary,
} from "./action-bar";
import {
  clearDraft,
  draftKey,
  fingerprint,
  mergeDraft,
  readDraft,
  savedAgo,
  writeDraft,
} from "./draft-store";
import { defaultWhen, initialState, type FormState } from "./form-state";
import { MessagesTab } from "./messages-tab";
import { ReviewStep } from "./review-step";
import { StepPanel, Stepper, stepFrom, type Step } from "./stepper";
import { scheduleSummary, shortTimeZone } from "./summary";
import { SurveySection } from "./survey-section";
import { WebinarTab } from "./webinar-tab";

export type { FormState };
export { DEFAULT_ATTENDEE_LIMIT } from "./form-state";

const MESSAGE_FIELDS = new Set(["reminders"]);
const AUTOSAVE_MS = 600;

function stepForFields(fields: Record<string, string>): Step {
  const keys = Object.keys(fields);
  if (keys.length > 0 && keys.every((k) => MESSAGE_FIELDS.has(k))) {
    return "followups";
  }
  return "details";
}

function anchorForFields(fields: Record<string, string>): string | null {
  const keys = Object.keys(fields);
  if (keys.includes("reminders")) return null;
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
      <ScheduleFormGate webinar={webinar} />
    </Suspense>
  );
}

function ScheduleFallback() {
  return (
    <div className="grid gap-5 pb-48 lg:pb-24">
      <div className="h-4 w-80 animate-pulse rounded bg-surface-2" />
      <div className="h-9 w-full max-w-xl animate-pulse rounded-lg bg-surface-2" />
      <div className="h-72 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

/* The form only renders in the browser, once the session is known.
 *
 * Its first state depends on things a server render cannot see — the host's
 * own clock and zone for the default start, the browser's zone list, and the
 * draft this browser kept — so rendering it on the server only produced a
 * hydration mismatch that React resolved by throwing the tree away. And the
 * draft is keyed by account, so it waits for the session rather than reading
 * an anonymous key and then another. */
function ScheduleFormGate({ webinar }: { webinar: Webinar | null }) {
  const hydrated = useHydrated();
  const { account, status } = useSession();
  if (!hydrated || status === "loading") return <ScheduleFallback />;
  return (
    <ScheduleFormBody
      key={account?.id ?? "anon"}
      webinar={webinar}
      accountId={account?.id}
    />
  );
}

type Restored = { savedAt: number; messages: MessageSlot[] };

function ScheduleFormBody({
  webinar,
  accountId,
}: {
  webinar: Webinar | null;
  accountId: string | undefined;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const config = useAppConfig();
  const { notify } = useToast();
  const editing = webinar !== null;

  /* The step, mirrored into ?step= so a reload or a shared link opens the
   * same one. Written with history.replaceState, NOT router.replace: a router
   * navigation is a server round trip, and when that request came back as
   * anything but a flight payload — a deploy since the page loaded, the
   * middleware's session lookup timing out — Next fell back to a full page
   * load, and the whole form went with it. replaceState is synced into
   * useSearchParams by Next without asking the server anything. */
  const fromUrl = stepFrom(search.get("step"));
  const [step, setStep] = useState<Step>(fromUrl);
  const [urlStep, setUrlStep] = useState<Step>(fromUrl);
  if (fromUrl !== urlStep) {
    setUrlStep(fromUrl);
    setStep(fromUrl);
  }
  const [visited, setVisited] = useState<Set<Step>>(() => new Set([fromUrl]));

  const topRef = useRef<HTMLDivElement>(null);
  const go = useCallback((next: Step, scroll = false) => {
    setStep(next);
    // urlStep catches up when useSearchParams reflects this replaceState;
    // setting it here would make the render before that "see" the old URL
    // disagree with it and snap back to the previous step.
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
    const url = new URL(window.location.href);
    if (next === "details") url.searchParams.delete("step");
    else url.searchParams.set("step", next);
    window.history.replaceState(window.history.state, "", url);
    if (scroll) {
      requestAnimationFrame(() => {
        const top = topRef.current;
        if (top && top.getBoundingClientRect().top < 0) {
          top.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    }
  }, []);

  /* The form's own draft. See draft-store.ts. */
  const storageKey = draftKey(accountId, webinar?.id);
  const [serverForm] = useState<FormState>(() =>
    initialState(webinar, config.maxAttendees),
  );
  const serverPrint = useMemo(() => fingerprint(serverForm), [serverForm]);
  const base = editing ? serverPrint : null;
  const [boot] = useState<{ form: FormState; restored: Restored | null }>(
    () => {
      const draft = readDraft(storageKey, base);
      if (!draft) return { form: serverForm, restored: null };
      const merged = mergeDraft(serverForm, draft.form);
      // A new webinar's kept start can have slipped into the past while it
      // waited; the server would refuse it, so offer the next slot instead.
      const at = zonedToInstant(merged.date, merged.time, merged.timeZone);
      const stale = !editing && (!at || at.getTime() < Date.now());
      return {
        form: stale ? { ...merged, ...defaultWhen() } : merged,
        restored: {
          savedAt: draft.savedAt,
          messages: draft.extras.messages ?? [],
        },
      };
    },
  );
  const [form, setForm] = useState<FormState>(boot.form);
  const [restored, setRestored] = useState<Restored | null>(boot.restored);
  const [restoreGen, setRestoreGen] = useState(0);
  const pendingMessages = useRef<MessageSlot[]>(restored?.messages ?? []);
  const [messagesPrint, setMessagesPrint] = useState(() =>
    JSON.stringify(pendingMessages.current),
  );

  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scheduled" | "draft" | null>(null);
  const messagesRef = useRef<MessagesSaveHandle>(null);
  const [followUps, setFollowUps] = useState<FollowUpSummary>(null);

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

  /* Autosave to this browser, and what the footer says about it.
   *
   * "Dirty" is measured against what the server has (or, for a new webinar,
   * the empty form), not against the last local write — the local copy is a
   * safety net, and the host still has something unsaved until the webinar
   * itself is saved. */
  const formPrint = useMemo(() => fingerprint(form), [form]);
  const localPrint = `${formPrint}|${messagesPrint}`;
  const cleanPrint = `${serverPrint}|[]`;
  const dirty =
    localPrint !== cleanPrint ||
    pendingImage !== null ||
    imageRemoved ||
    form.streamKey !== "";
  const [written, setWritten] = useState<{
    print: string;
    at: number;
  } | null>(() =>
    boot.restored ? { print: localPrint, at: boot.restored.savedAt } : null,
  );
  const [storageBroken, setStorageBroken] = useState(false);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    const timer = window.setTimeout(() => {
      if (localPrint === cleanPrint) {
        clearDraft(storageKey);
        setWritten(null);
        return;
      }
      const at = writeDraft(storageKey, base, form, {
        messages: pendingMessages.current,
      });
      if (at == null) setStorageBroken(true);
      else setWritten({ print: localPrint, at });
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
    // `form` is represented by localPrint; writing on every new object
    // identity with the same content would only churn storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPrint, cleanPrint, storageKey, base]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (submitted.current) return;
      e.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const now = useNow(15_000);
  const status: DraftStatus =
    busy !== null
      ? { kind: "saving" }
      : localPrint === cleanPrint
        ? pendingImage || imageRemoved
          ? { kind: "unsaved" }
          : { kind: "pristine" }
        : storageBroken
          ? { kind: "unavailable" }
          : written?.print === localPrint
            ? { kind: "saved", ago: savedAgo(written.at, now ?? written.at) }
            : { kind: "unsaved" };

  function discardRestored() {
    clearDraft(storageKey);
    pendingMessages.current = [];
    setMessagesPrint("[]");
    setForm(initialState(webinar, config.maxAttendees));
    setWritten(null);
    setRestored(null);
    setFields({});
    setError(null);
    // Remounts the follow-ups editor without the overrides the draft carried.
    setRestoreGen((n) => n + 1);
  }

  function toInput(status: "scheduled" | "draft"): WebinarInput | null {
    const startsAt = zonedToInstant(form.date, form.time, form.timeZone);
    if (!startsAt) {
      setFields({ startsAt: "Pick a valid date and time." });
      flushSync(() => go("details"));
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
      ...(form.kind === "simulive" && form.simuliveRecordingId
        ? { simuliveRecordingId: form.simuliveRecordingId }
        : {}),
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
      flushSync(() => go("survey"));
      scrollToId("survey");
      setBusy(null);
      return;
    }

    try {
      let saved = editing
        ? await api.updateWebinar(webinar.id, input)
        : await api.createWebinar(input);
      /* The webinar exists now, so the local copy has done its job — and must
       * go, or the next "Schedule a webinar" would reopen this one. From here
       * on nothing is written back and leaving the page does not warn. */
      submitted.current = true;
      clearDraft(storageKey);

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
          flushSync(() => go(stepForFields(err.fields!)));
          const anchor = anchorForFields(err.fields);
          if (anchor) scrollToId(anchor);
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
  const done: Record<Step, boolean> = {
    details: form.topic.trim() !== "" && startsAtPreview !== null,
    survey: visited.has("survey"),
    followups: visited.has("followups"),
    review: false,
  };

  /* Enter in a one-line field used to submit the whole form — scheduling a
   * webinar, and emailing its panel, from a half-typed title. Submitting is
   * what the Schedule button is for. */
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    const t = e.target;
    if (
      e.key === "Enter" &&
      t instanceof HTMLInputElement &&
      !["checkbox", "radio", "submit", "button"].includes(t.type)
    ) {
      e.preventDefault();
    }
  }

  return (
    <form
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        if (!formEl.checkValidity()) {
          const invalid = formEl.querySelector(":invalid");
          const at =
            invalid instanceof HTMLElement
              ? invalid
                  .closest("[data-schedule-tab]")
                  ?.getAttribute("data-schedule-tab")
              : null;
          flushSync(() => go(stepFrom(at ?? null)));
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
      <div ref={topRef} className="scroll-mt-20 pb-48 lg:pb-28">
        <Stepper step={step} done={done} onStep={(s) => go(s, true)} />

        <div className="grid gap-5">
          {restored && (
            <Alert tone="info">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  We kept the changes you hadn&apos;t saved (
                  {savedAgo(restored.savedAt, now ?? restored.savedAt)}).
                  {!editing && " The cover image, if you picked one, needs picking again."}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={discardRestored}
                >
                  {editing ? "Discard my changes" : "Start over"}
                </Button>
              </span>
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {!error && Object.keys(fields).length > 0 && (
            <Alert tone="error">{Object.values(fields).join(" ")}</Alert>
          )}

          {/* All four panels stay mounted; the stepper only picks the one that
              shows. Nothing is unmounted by moving between them, and a failed
              submit can still find the invalid field and open its step. */}
          <StepPanel step="details" current={step}>
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
            />
          </StepPanel>
          <StepPanel step="survey" current={step}>
            <SurveySection survey={survey.node} />
          </StepPanel>
          <StepPanel step="followups" current={step}>
            <MessagesTab
              key={restoreGen}
              previewWebinar={previewWebinar}
              slug={webinar?.id}
              saveRef={messagesRef}
              onSummary={setFollowUps}
              onLoadError={() => setFollowUps("failed")}
              initialPending={pendingMessages.current}
              onPendingChange={(slots) => {
                pendingMessages.current = slots;
                setMessagesPrint(JSON.stringify(slots));
              }}
            />
          </StepPanel>
          <StepPanel step="review" current={step}>
            <ReviewStep
              form={form}
              when={summary.lead}
              surveyOn={survey.on}
              followUps={followUps}
              hasImage={imagePreview !== null}
              onStep={(s) => go(s, true)}
            />
          </StepPanel>
        </div>
      </div>

      <ActionBar
        lead={summary.lead}
        rest={summary.rest}
        editing={editing}
        showDraft={showDraft}
        busy={busy}
        status={status}
        followUps={followUps}
        followUpsActive={step === "followups"}
        onFollowUps={() => go("followups", true)}
        onDraft={() => void submit("draft")}
      />
    </form>
  );
}

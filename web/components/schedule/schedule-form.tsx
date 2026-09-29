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
import {
  FeatureCloudRecording,
  FeatureJoinWithoutRegistration,
  type MessageSlot,
  type Webinar,
  type WebinarInput,
} from "@/lib/api-types";
import { useHydrated, useNow } from "@/lib/clock";
import { zonedToInstant } from "@/lib/format";
import { optionsProblem } from "@/lib/registration-questions";
import {
  issuesFor,
  legacyAnchor,
  nextStep,
  prevStep,
  scheduleIssues,
  STEPS,
  stepIndex,
} from "@/lib/schedule-wizard";
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
import { panelId, StepCards, StepPanel, stepFrom, type Step } from "./stepper";
import { scheduleSummary, shortTimeZone } from "./summary";
import { WebinarTab } from "./webinar-tab";

export type { FormState };
export { DEFAULT_ATTENDEE_LIMIT } from "./form-state";

const MESSAGE_FIELDS = new Set(["reminders"]);
const AUTOSAVE_MS = 600;

function stepForFields(fields: Record<string, string>): Step {
  const keys = Object.keys(fields);
  if (keys.length > 0 && keys.every((k) => MESSAGE_FIELDS.has(k))) {
    return "messages";
  }
  return "webinar";
}

/** Where a server-side field error is fixed: a field id when there is one. */
function targetForFields(fields: Record<string, string>): string | null {
  const keys = Object.keys(fields);
  if (keys.includes("reminders")) return null;
  if (keys.includes("topic")) return "topic";
  if (keys.some((k) => ["startsAt", "timeZone", "durationMin"].includes(k))) {
    return "date";
  }
  if (
    keys.some((k) =>
      ["passcode", "approval", "customQuestions", "attendeeLimit"].includes(k),
    )
  ) {
    return "settings-registration";
  }
  if (keys.includes("panelistEmails")) return "panelists";
  return "settings-the-basics";
}

/* Scroll to an element and, when it is (or holds) the field at fault, focus
 * it — so the host lands on the thing to fix, not just near it. */
function focusTarget(id: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const field = el.matches("input, textarea, select")
      ? el
      : el.querySelector<HTMLElement>('[aria-invalid="true"], :invalid');
    (field ?? (el.tabIndex >= 0 || el.hasAttribute("tabindex") ? el : null))
      ?.focus({ preventScroll: true });
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
  const { account } = useSession();
  const { notify } = useToast();
  const openJoin = (account?.features ?? []).includes(
    FeatureJoinWithoutRegistration,
  );
  const editing = webinar !== null;

  /* The step, mirrored into ?step= so a reload or a shared link opens the
   * same one. Written with history.replaceState, NOT router.replace: a router
   * navigation is a server round trip, and when that request came back as
   * anything but a flight payload — a deploy since the page loaded, the
   * middleware's session lookup timing out — Next fell back to a full page
   * load, and the whole form went with it. replaceState is synced into
   * useSearchParams by Next without asking the server anything. */
  const rawStep = search.get("step");
  const fromUrl = stepFrom(rawStep);
  const [step, setStep] = useState<Step>(fromUrl);
  const [urlStep, setUrlStep] = useState<Step>(fromUrl);
  if (fromUrl !== urlStep) {
    setUrlStep(fromUrl);
    setStep(fromUrl);
  }
  const go = useCallback((next: Step, scroll = false) => {
    setStep(next);
    // urlStep catches up when useSearchParams reflects this replaceState;
    // setting it here would make the render before that "see" the old URL
    // disagree with it and snap back to the previous step.
    const url = new URL(window.location.href);
    if (next === "webinar") url.searchParams.delete("step");
    else url.searchParams.set("step", next);
    window.history.replaceState(window.history.state, "", url);
    if (scroll) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0 });
        // The button that moved us may be gone (Next becomes Schedule), so
        // put keyboard focus at the start of the step that just opened.
        document
          .getElementById(panelId(next))
          ?.focus({ preventScroll: true });
      });
    }
  }, []);

  /* Old links: ?step=survey opened a Survey step, which is now the last
   * section of The webinar — open that step there, and say so in the URL. */
  const [legacy] = useState(() => ({
    anchor: legacyAnchor(rawStep),
    stale: rawStep !== null && rawStep !== fromUrl,
  }));
  useEffect(() => {
    if (legacy.stale) {
      const url = new URL(window.location.href);
      if (fromUrl === "webinar") url.searchParams.delete("step");
      else url.searchParams.set("step", fromUrl);
      window.history.replaceState(window.history.state, "", url);
    }
    if (legacy.anchor) {
      const id = legacy.anchor;
      // After the survey builder has laid out, or the scroll lands short.
      const t = window.setTimeout(() => focusTarget(id), 150);
      return () => window.clearTimeout(t);
    }
    // Once, for the URL the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      flushSync(() => go("webinar"));
      focusTarget("date");
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
      registrationRequired: openJoin ? form.registrationRequired : true,
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
      // A host without cloud recording cannot turn auto-record on, including from a
      // draft saved before the switch existed.
      options: {
        ...form.options,
        postWebinarSurvey: survey.on,
        ...((account?.features ?? []).includes(FeatureCloudRecording)
          ? {}
          : { autoRecord: false }),
      },
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
      focusTarget("survey");
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
          const target = targetForFields(err.fields);
          if (target) focusTarget(target);
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
  const summary = scheduleSummary(
    openJoin ? form : { ...form, registrationRequired: true },
    summaryZone,
  );
  const showDraft = !editing || webinar.status === "draft";

  const questionProblem =
    form.questions
      .filter((q) => q.label.trim() !== "")
      .map(optionsProblem)
      .find((p) => p !== null) ?? null;
  const issues = scheduleIssues({
    topic: form.topic,
    startsAt: startsAtPreview,
    editing,
    now,
    questionProblem,
    watchUrl: form.streamWatchUrl,
    multistream: Boolean(form.options.multistream),
    surveyProblem: survey.problem(),
  });

  /* Inline errors for problems the host has been sent to fix. Derived from
   * the live issue list, so each one clears the moment it is fixed; the
   * server's own field errors are kept as they came. */
  const [told, setTold] = useState<ReadonlySet<string>>(() => new Set());
  const shownFields: Record<string, string> = { ...fields };
  for (const i of issues) {
    if (i.field && told.has(i.id) && !shownFields[i.field]) {
      shownFields[i.field] = i.message;
    }
  }

  const messagesOn =
    followUps && followUps !== "failed" ? followUps.enabled : null;
  const done: Record<Step, boolean> = {
    webinar: issuesFor(issues, "webinar").length === 0,
    messages: false,
  };
  const cardDetails: Record<Step, string> = {
    webinar: "Title, time, registration, the room",
    messages:
      messagesOn == null
        ? "Reminders, WhatsApp, after it ends"
        : `Reminders, WhatsApp, after it ends · ${messagesOn} on`,
  };

  /* Can the host leave `target` going forward? Its own issues first, then
   * the browser's constraints on its fields (a date before today, a
   * malformed link) as a backstop. On a problem, opens the step that has it
   * and lands on the field — never a silent refusal. */
  function passes(target: Step): boolean {
    const own = issuesFor(issues, target);
    if (own.length > 0) {
      setTold((t) => new Set([...t, ...own.map((i) => i.id)]));
      flushSync(() => go(target));
      focusTarget(own[0].target);
      return false;
    }
    const panel = document.getElementById(panelId(target));
    const invalid = panel?.querySelector(":invalid");
    if (
      invalid instanceof HTMLInputElement ||
      invalid instanceof HTMLTextAreaElement ||
      invalid instanceof HTMLSelectElement
    ) {
      flushSync(() => go(target));
      invalid.focus();
      invalid.reportValidity();
      return false;
    }
    return true;
  }

  function next() {
    const to = nextStep(step);
    if (to && passes(step)) go(to, true);
  }

  /* The step cards: back freely; forward the way Next goes, so a card can't
   * skip a step that would stop Next. */
  function openStep(target: Step) {
    const to = stepIndex(target);
    if (target === step) return;
    if (to < stepIndex(step)) {
      go(target, true);
      return;
    }
    for (const s of STEPS.slice(0, to)) {
      if (!passes(s.id)) return;
    }
    go(target, true);
  }

  const back = prevStep(step);
  const upcoming = nextStep(step);
  const nextLabel = upcoming
    ? `Next: ${STEPS[stepIndex(upcoming)].title} →`
    : null;

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
        // Only the last step has a submit button; anything else that gets
        // here (a browser's implicit submission) is not a request to schedule.
        if (nextStep(step) !== null) return;
        // Schedule checks The webinar the way Next does, and opens it on the
        // first problem.
        for (const s of STEPS) {
          if (!passes(s.id)) return;
        }
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
      <div className="grid gap-5 pb-48 lg:pb-28">
        <p className="-mt-1 text-[13px] text-ink-2">
          Set up the webinar, then what your attendees get. You can change
          anything later.
        </p>

        <StepCards
          step={step}
          done={done}
          details={cardDetails}
          onStep={openStep}
        />

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

          {/* Both panels stay mounted; a card only picks the one that shows.
              Nothing is unmounted by moving between them (reminder editors and
              the survey builder keep their state), and a failed submit can
              still find the invalid field and open its step. */}
          <StepPanel step="webinar" current={step}>
            <WebinarTab
              form={form}
              set={set}
              fields={shownFields}
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
              survey={survey.node}
            />
          </StepPanel>
          <StepPanel step="messages" current={step}>
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
        </div>
      </div>

      <ActionBar
        lead={summary.lead}
        rest={summary.rest}
        stepNumber={stepIndex(step) + 1}
        stepCount={STEPS.length}
        nextLabel={nextLabel}
        finalLabel={editing ? "Save changes" : "Schedule"}
        showDraft={showDraft}
        busy={busy}
        status={status}
        followUps={followUps}
        onBack={back ? () => go(back, true) : null}
        onNext={next}
        onDraft={() => void submit("draft")}
      />
    </form>
  );
}

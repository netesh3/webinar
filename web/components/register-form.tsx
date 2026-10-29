"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useJoinKeys, useRegistrations } from "./registrations";
import { Alert, CopyField, Modal, Spinner } from "./controls";
import { startGoogleOAuth } from "./google-continue";
import { ArrowLeftIcon, CalendarIcon, CheckIcon, UserPlusIcon } from "./icons";
import { useSession, useShareOrigin, useAppConfig } from "./providers";
import { Badge, Button, ButtonLink } from "./ui";
import { DIAL_CODES, dialOptions, nationalPhoneDigits } from "@/lib/dial-codes";
import { formatDay, formatTime, formatTimeRange, tzLabel } from "@/lib/format";
import { downloadIcs, googleCalendarUrl } from "@/lib/calendar";
import { ApiError, api } from "@/lib/api";
import { needsConsentPrompt } from "@/lib/whatsapp-consent";
import type { Account, RegisterRequest, Registration, Webinar } from "@/lib/api-types";
import { OfferJoinWithoutRegistration } from "@/lib/api-types";
import {
  clearPendingWebinarRegister,
  isGmailAddress,
  readPendingWebinarRegister,
  savePendingWebinarRegister,
  webinarSignInHref,
} from "@/lib/webinar-register";
import { usePrimeMediaOnGesture } from "@/lib/media-unlock";
import {
  androidChromeIntent,
  currentInAppBrowser,
  currentIsAndroid,
  currentIsNativeApp,
} from "@/lib/device";
import { CHECKBOX_YES } from "@/lib/registration-questions";
import { WhatsAppOptInCheckbox } from "@/engage";
import { PushOptIn } from "./pwa";

/* Registration.
 *
 * Works two ways. Signed in, the fields are prefilled from the account and the
 * registration is linked to it, so it follows the person to another browser.
 * Signed out, it still works — the join key that comes back is the credential,
 * and this browser holds it.
 *
 * Country is a free text field with autocomplete rather than a dropdown. A short
 * list of countries is wrong for most of the world, and the full ISO list is 249
 * entries nobody wants to scroll; the browser already knows the answer and will
 * autofill it.
 */

/** Splits an account's single name field for the two-field form. Everything
 *  before the last space is the first name — wrong for some naming conventions,
 *  but it never drops anything, and both fields stay editable. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

/**
 * JoinGate is the last step of registering: either the way in, or when it opens.
 *
 * A static sentence used to sit here — "You can join from 09:45 on Wed, 9 Sept 2026" — and it
 * had two problems. It read as a refusal rather than as a wait, and it was frozen: somebody who
 * registered ten minutes before a webinar sat looking at that sentence while the doors opened
 * behind it, because nothing re-rendered until they reloaded a page they had no reason to
 * reload. The countdown below fixes both. It ticks, so the wait is visibly finite, and when it
 * reaches zero this component swaps itself for the button with no reload.
 *
 * The tick rate is not constant. A countdown reading "in 2 days" redrawn every second is 86,400
 * renders to change one digit, so it slows down when there is nothing to see and speeds up in
 * the last two minutes, which is the only part anybody watches.
 *
 * `now` starts null and is set in an effect rather than during render. `Date.now()` in a render
 * is different on the server and in the browser, which is a hydration mismatch on a page that
 * looks fine — and this component is reached both ways.
 */
/* useDoorsOpen is the ticking clock behind both entrances.
 *
 * Extracted from JoinGate because the dual-CTA panel needs the same answer: "Join as Guest"
 * must not be offered three weeks early, since the server refuses it with `too_early` and
 * would leave behind a registration row with no email on it. One hook means the button and
 * the countdown cannot disagree about whether the door is open.
 *
 * `remaining` is null until the first tick. See JoinGate for why the clock is read in an
 * effect and not during a render, and why the tick rate is not constant.
 */
function useDoorsOpen(w: Webinar): { open: boolean; remaining: number | null } {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const opens = openingTime(w).getTime();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      const remaining = opens - Date.now();
      timer = setTimeout(
        tick,
        remaining > 0 && remaining < 120_000 ? 1_000 : 20_000,
      );
    };
    tick();
    return () => clearTimeout(timer);
  }, [w]);

  return {
    open: doorsOpen(w, now),
    remaining: now === null ? null : openingTime(w).getTime() - now,
  };
}

function JoinGate({ w, lead = false }: { w: Webinar; lead?: boolean }) {
  const { open, remaining } = useDoorsOpen(w);

  if (open) {
    /* Same tab, deliberately — this used to open in a new one.
     *
     * A tab opened with window.open()/target="_blank" starts with no user-gesture
     * history of its own: the click that opened it happened in the tab that is
     * still sitting there, not in the one that just appeared. Browsers withhold
     * autoplay-with-sound until a page has been directly interacted with, so
     * every attendee joining that way landed in a room that had to ask them to
     * click a "Click to enable sound" button before they could hear anything.
     * A same-tab navigation is a continuation of the very click that triggered
     * it, which is exactly the case autoplay policies are designed to allow —
     * so for the common path (clicking this button) the room's audio just
     * starts. The confirmation page's join key is not lost by leaving: it was
     * already saved to this browser and is recoverable from the webinar's own
     * page besides. */
    return (
      <ButtonLink
        href={`/webinars/${w.id}/room`}
        size="lg"
        className={lead ? "mb-5 w-full" : "mt-2 w-full"}
      >
        {w.status === "live" ? "Join now — live" : "Join now"}
      </ButtonLink>
    );
  }

  /* Before the first tick, `remaining` is null and the time left is unknown. Showing the
   * absolute time and no countdown is the honest render for that instant; the countdown
   * appears a moment later. */
  return (
    <div
      className={`${lead ? "mb-5" : "mt-2"} rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-center`}
    >
      <p className="text-[12px] tracking-[0.04em] text-ink-3 uppercase">
        Doors open in
      </p>
      <p className="mt-0.5 text-[19px] font-semibold tabular-nums tracking-[-0.01em] text-ink">
        {remaining === null ? "—" : formatCountdown(remaining)}
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
        {formatTime(openingTime(w).toISOString(), w.timeZone)}{" "}
        {tzLabel(w.startsAt, w.timeZone)} on {formatDay(w.startsAt, w.timeZone)}{" "}
        — {JOIN_GRACE_MIN} minutes before it starts. This page opens the door by
        itself; you do not need to reload.
      </p>
    </div>
  );
}

/* "2 days 4 hrs", "3 hrs 12 min", "48 sec".
 *
 * Two units at most, and never a unit that is zero. "1 day 0 hrs 0 min 12 sec" is arithmetic;
 * what somebody wants to know is roughly how long, at the precision that matters at that
 * distance. Seconds only appear under a minute, where they are the whole point. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0)
    return `${days} ${days === 1 ? "day" : "days"}${hours ? ` ${hours} hr` : ""}`;
  if (hours > 0) return `${hours} hr${minutes ? ` ${minutes} min` : ""}`;
  if (minutes > 0) return `${minutes} min${seconds ? ` ${seconds} sec` : ""}`;
  return `${seconds} sec`;
}

/* When the doors open, in the browser's terms.
 *
 * JOIN_GRACE_MIN must match joinGrace in api/internal/api/join.go. Two copies of one
 * number is a real cost, and the alternative is worse: a UI that offers a button the
 * server refuses, or hides one it would have allowed. The server is the authority — this
 * only decides what to offer.
 */
const JOIN_GRACE_MIN = 15;

function openingTime(w: Webinar): Date {
  return new Date(new Date(w.startsAt).getTime() - JOIN_GRACE_MIN * 60_000);
}

/** Live means open, whatever the clock says: a session that starts late must not shut out
 *  the people already waiting for it.
 *
 *  `now` is passed in rather than read from the clock, so the only place that calls Date.now()
 *  is an effect. Reading it during a render makes the server and the browser disagree, which is
 *  a hydration mismatch on a page that looks fine. A null `now` means the first tick has not
 *  happened yet: unknown, so not open. */
function doorsOpen(w: Webinar, now: number | null): boolean {
  if (w.status === "live") return true;
  if (now === null) return false;
  const opens = openingTime(w).getTime();
  return Number.isNaN(opens) || now >= opens;
}

export function RegisterForm({ webinar: w }: { webinar: Webinar }) {
  const { registrationFor, remember, registrations, error, retry } =
    useRegistrations();
  const { account, status } = useSession();
  const existing = registrationFor(w.id);
  // The Join tap also unlocks a <video> for Safari's sake (lib/media-unlock.ts).
  usePrimeMediaOnGesture();

  useEffect(() => {
    if (existing) clearPendingWebinarRegister(w.id);
  }, [existing, w.id]);

  // A lookup that failed leaves the answer unknown. Offering the form anyway is
  // the right fallback: registering again is idempotent and returns the same join
  // key, so the worst case is one wasted click rather than a dead page.
  if (registrations === null && error) {
    return (
      <div>
        <div className="mb-3">
          <Alert tone="warn" title="Couldn't check your existing registration">
            {error}{" "}
            <button
              onClick={retry}
              className="font-medium text-brand hover:underline"
            >
              Try again
            </button>
            , or register below — if you already have, you&apos;ll get the same
            join key back.
          </Alert>
        </div>
        <RegisterEntry
          key={account?.id ?? "guest"}
          webinar={w}
          account={account}
          onRegistered={remember}
        />
      </div>
    );
  }

  // Still resolving who this is: hold the space so the card doesn't jump.
  if (registrations === null || status === "loading") {
    return <div className="h-72 animate-pulse rounded-xl bg-surface-2" />;
  }

  if (existing) {
    return <Confirmed webinar={w} registration={existing} />;
  }

  // Keyed by the account so the prefilled values come from props on mount rather
  // than being copied in by an effect — and signing in mid-visit refills them.
  return (
    <>
      {w.series && <SeriesCovers series={w.series} />}
    <RegisterEntry
      key={account?.id ?? "guest"}
      webinar={w}
      account={account}
      onRegistered={remember}
    />
    </>
  );
}

function SeriesCovers({ series }: { series: { summary?: string } }) {
  return (
    <p className="mb-3 text-[13.5px] leading-relaxed text-ink-2">
      One registration covers every session in this series
      {series.summary ? ` — ${series.summary}` : ""}. You will not be asked to
      sign up again for each one.
    </p>
  );
}

/* The form, unless a Gmail visitor just came back from Google.
 *
 * The pending body was saved before the redirect and rides in sessionStorage,
 * which survives that same-tab round trip. Checking it before the ordinary
 * form means a required answer is not dropped by the signed-in shortcut, which
 * registers from the account alone. The first paint is a placeholder on the
 * server and the client alike — reading storage during render would not match.
 */
function RegisterEntry({
  webinar,
  account,
  onRegistered,
}: {
  webinar: Webinar;
  account: Account | null;
  onRegistered: (reg: Registration) => void;
}) {
  const [phase, setPhase] = useState<"check" | "resume" | "form">("check");
  const [draft, setDraft] = useState<RegisterRequest | null>(null);

  useEffect(() => {
    // sessionStorage is empty during SSR. Reading it while rendering would not
    // match the server HTML, so the check waits until after mount.
    /* eslint-disable react-hooks/set-state-in-effect -- external sessionStorage, read once after mount */
    if (account) {
      const pending = readPendingWebinarRegister(webinar.id);
      if (pending) {
        setDraft(pending);
        setPhase("resume");
        return;
      }
    }
    setPhase("form");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [account, webinar.id]);

  if (phase === "check") {
    return <div className="h-72 animate-pulse rounded-xl bg-surface-2" />;
  }
  if (phase === "resume" && draft && account) {
    return (
      <ResumePendingRegister
        webinar={webinar}
        account={account}
        draft={draft}
        onRegistered={onRegistered}
      />
    );
  }
  return (
    <EntryChoice
      webinar={webinar}
      account={account}
      onRegistered={onRegistered}
    />
  );
}

/* Two doors, and the choice between them.
 *
 * A shared link reaches two kinds of person and one form was serving both badly. Somebody a
 * colleague messaged four minutes before the session starts will not fill in six fields, and
 * was being asked to; somebody evaluating the topic for their team is happy to, and their
 * details are the reason a host runs a webinar at all. So: a name-only door and a full one,
 * chosen explicitly rather than guessed at.
 *
 * The panel expands IN PLACE instead of navigating. The context — what this is, when it is,
 * who is presenting — is the reason somebody is about to hand over their name, and taking it
 * away at the moment of the decision is how a landing page loses the registration.
 *
 * "choose" is not shown when there is only one door. A single button with nothing to compare
 * it against is a form with an extra click in front of it, so the guest-only case skips
 * straight to what it offers.
 */
type EntryMode = "choose" | "guest" | "register";

function EntryChoice({
  webinar: w,
  account,
  onRegistered,
}: {
  webinar: Webinar;
  account: Account | null;
  onRegistered: (reg: Registration) => void;
}) {
  const { open } = useDoorsOpen(w);

  /* Guest entry needs the door to be open as well as allowed.
   *
   * `guestJoinAllowed` is the server's answer about the webinar — no manual approval, no
   * passcode — and it says nothing about the clock. The endpoint refuses an early guest with
   * `too_early`, so offering the button before the doors open would be offering a button that
   * fails. Registering early is exactly right, though, which is why only one of the two is
   * gated on this. */
  // The server already answers false while join without registration is paused for
  // webinars; the constant is checked here too so the button hides with the same switch.
  const guestAvailable = OfferJoinWithoutRegistration && w.guestJoinAllowed && open;

  /* The initial mode, and then the user owns it.
   *
   * `guestAvailable` changes mid-visit — somebody who lands ten minutes early sees only the
   * form, and the doors open while they are looking at it. That has to REVEAL the guest
   * option, not switch to it: pushing them back to the choice screen would discard whatever
   * they had typed, at the moment they were about to finish. So the only thing that changes
   * is the "Other ways to join" link below, which appears when there is finally another way.
   */
  const [mode, setMode] = useState<EntryMode>(
    guestAvailable ? "choose" : "register",
  );

  if (mode === "guest") {
    return (
      <GuestJoinFields
        webinar={w}
        onBack={() => setMode("choose")}
        onRegister={() => setMode("register")}
      />
    );
  }

  if (mode === "register") {
    // No way back when there was never a choice: a "Back" that returns to a screen with
    // one button on it is a dead end that looks like a mistake.
    const onBack = guestAvailable ? () => setMode("choose") : undefined;
    if (identityKnown(account, w)) {
      return (
        <KnownAttendeeRegister
          webinar={w}
          account={account!}
          onRegistered={onRegistered}
          onBack={onBack}
        />
      );
    }
    return (
      <RegisterFields
        webinar={w}
        account={account}
        onRegistered={onRegistered}
        onBack={onBack}
      />
    );
  }

  return (
    <div>
      <WhenHeader webinar={w} title="Join this webinar" />

      <div className="grid gap-2">
        <Button size="lg" className="w-full" onClick={() => setMode("guest")}>
          <UserPlusIcon className="size-4" />
          Join as Guest
        </Button>
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={() => setMode("register")}
        >
          Register &amp; Join
        </Button>
      </div>

      {/* What the difference actually is, in the terms that matter to the person choosing.
          "Guest" and "Register" are our words for our reasons; theirs are "how fast" and
          "what do you keep". */}
      <dl className="mt-4 grid gap-2.5 border-t border-line pt-3.5 text-[12px] leading-relaxed">
        <div>
          <dt className="font-medium text-ink">Join as Guest</dt>
          <dd className="text-ink-2">
            Your name and nothing else. Straight into the session.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Register &amp; Join</dt>
          <dd className="text-ink-2">
            Adds your email, so you keep a join link you can come back with —
            and the host can send you the recording.
          </dd>
        </div>
      </dl>
      <ExistingAccountSignIn webinarId={w.id} account={account} />
    </div>
  );
}

/* The shared header: what, when, and what it costs.
 *
 * The same three lines on the choice screen and on both forms, so expanding a door does not
 * feel like arriving somewhere else.
 */
function WhenHeader({
  webinar: w,
  title,
}: {
  webinar: Webinar;
  title: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {w.priceUsd ? (
          <span className="text-[20px] font-semibold">${w.priceUsd}</span>
        ) : (
          <Badge tone="ok">Free</Badge>
        )}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">
        {formatDay(w.startsAt, w.timeZone)} ·{" "}
        {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
        {tzLabel(w.startsAt, w.timeZone)}
      </p>
    </div>
  );
}

/** A way back to the choice, above whichever form is expanded. */
function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"
    >
      <ArrowLeftIcon className="size-3.5" />
      Other ways to join
    </button>
  );
}

/* Guest entry: one field.
 *
 * The response is a join token AND a join key. The token proves every gate was cleared — the
 * lock, the ceiling, the door — so this never routes somebody into a room that would bounce
 * them. The KEY is what gets stored, because it is the only thing that gets a guest back in
 * after a reload, and the room mints its own token on arrival exactly as it does for a
 * registrant. One code path in the room is worth one extra local HMAC.
 */
function GuestJoinFields({
  webinar: w,
  onBack,
  onRegister,
}: {
  webinar: Webinar;
  onBack: () => void;
  /** The server refused the name-only door. Show the registration form. */
  onRegister: () => void;
}) {
  const { add } = useJoinKeys();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const join = await api.guestJoin(w.id, name);
      // Stored before opening the room, so a reload finds the key rather than a
      // stranger with no way in.
      if (join.joinKey) add(join.joinKey, w.id);
      /* Same tab, client-side, like "Join now" (JoinGate): a new tab starts with no user
       * activation, so its room could not play sound without asking for a tap first. */
      router.push(`/webinars/${w.id}/room`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "registration_required") {
        onRegister();
        return;
      }
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        setError(err.fields ? "Some fields need attention." : err.message);
      } else {
        setError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <BackLink onBack={onBack} />
      <WhenHeader webinar={w} title="Join as Guest" />

      <div className="grid gap-3">
        <div>
          <label className="label" htmlFor="guest-name">
            Your name
          </label>
          <input
            id="guest-name"
            className="field"
            autoComplete="name"
            autoFocus
            required
            maxLength={60}
            placeholder="How you'll appear to everyone"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(fieldErrors.name)}
          />
          {fieldErrors.name && (
            <p className="mt-1 text-[11.5px] font-medium text-live">
              {fieldErrors.name}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-[12.5px] font-medium text-live">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy ? "Joining…" : "Join now"}
        </Button>

        <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
          No email needed. You will not get a join link, so keep this page if
          you might come back — or{" "}
          <button
            type="button"
            onClick={onBack}
            className="font-medium text-brand hover:underline"
          >
            register instead
          </button>
          .
        </p>
        <ExistingAccountSignIn webinarId={w.id} account={null} />
      </div>
    </form>
  );
}

/* A signed-in account with a name, email, and a typed phone already answered
 * the form. Google's People number does not count — registration still needs
 * the number they entered.
 *
 * Extra questions and a passcode are still asked, because those are about
 * this webinar, not about who the person is. Otherwise registering again is
 * one click on "Register & Join", not six fields.
 */
function identityKnown(account: Account | null, w: Webinar): boolean {
  if (!account?.name.trim() || !account.email.trim()) return false;
  // No phone is fine: ConsentRegister asks for it, with WhatsApp for this coach.
  if (w.passcodeRequired) return false;
  return !w.customQuestions.some((q) => q.required);
}

/* Signed in, and we already know the name and email.
 *
 * Consent to be registered is included because opening this door is the person
 * asking for it; the server still checks it. WhatsApp is not assumed: it is asked
 * for this coach unless they already opted in (ConsentRegister).
 */
function KnownAttendeeRegister({
  webinar: w,
  account,
  onRegistered,
  onBack,
}: {
  webinar: Webinar;
  account: Account;
  onRegistered: (reg: Registration) => void;
  onBack?: () => void;
}) {
  const base = useMemo<RegisterRequest>(() => {
    const { firstName, lastName } = splitName(account.name);
    return {
      firstName,
      lastName,
      email: account.email,
      company: account.org,
      jobTitle: account.title,
      phone: account.phone ?? "",
      consent: true,
      whatsappOptIn: false,
      answers: {},
    };
  }, [account]);
  return (
    <ConsentRegister
      webinar={w}
      account={account}
      base={base}
      onRegistered={onRegistered}
      onBack={onBack}
    />
  );
}

/* Register a signed-in person, asking first when this coach needs it.
 *
 * If they are already opted in with this webinar's coach and the account has a
 * phone, it is one click, as before. Otherwise a popup asks for the phone, which
 * registration requires and which cannot be skipped, and offers WhatsApp updates
 * from this coach, ticked like the form's box but optional. A phone saved here
 * also becomes the account's if it had none, so the app-wide phone prompt does not
 * follow them. Any other failure drops onto the full form.
 */
function ConsentRegister({
  webinar: w,
  account,
  base,
  onRegistered,
  onBack,
  onDone,
}: {
  webinar: Webinar;
  account: Account;
  base: RegisterRequest;
  onRegistered: (reg: Registration) => void;
  onBack?: () => void;
  onDone?: () => void;
}) {
  const { refresh } = useSession();
  const [stage, setStage] = useState<"checking" | "ask" | "registering" | "failed">("checking");
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [dialIso, setDialIso] = useState("IN");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [optIn, setOptIn] = useState(true);
  const dials = useMemo(() => dialOptions(), []);
  const started = useRef(false);
  const coach = w.host.name;

  const register = useCallback(
    async (phone: string, whatsappOptIn: boolean) => {
      setStage("registering");
      try {
        const reg = await api.register(w.id, {
          ...base,
          email: account.email,
          phone,
          consent: true,
          whatsappOptIn,
        });
        onDone?.();
        onRegistered(reg);
        // The account may have just gained this phone.
        void refresh();
      } catch (err) {
        if (err instanceof ApiError && err.fields?.phone) {
          setPhoneError(err.fields.phone);
          setStage("ask");
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not register.");
        setStage("failed");
      }
    },
    [account.email, base, onDone, onRegistered, refresh, w.id],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void api
      .whatsappConsent(w.id)
      .catch(() => null)
      .then((consent) => {
        if (!needsConsentPrompt(consent, account.phone)) {
          void register(account.phone!.trim(), true);
          return;
        }
        setPhoneNumber(nationalPhoneDigits(base.phone || consent?.phone || account.phone || ""));
        setStage("ask");
      });
  }, [account.phone, base.phone, register, w.id]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setPhoneError(null);
    const digits = phoneNumber.replace(/\D/g, "");
    if (!digits) {
      setPhoneError("Add a mobile number.");
      return;
    }
    if (digits.length < 8) {
      setPhoneError("That number looks too short — include the country code.");
      return;
    }
    void register(`+${DIAL_CODES[dialIso] ?? ""}${digits}`, optIn);
  }

  if (stage === "failed") {
    return (
      <div className="grid gap-3">
        {error && <Alert tone="error">{error}</Alert>}
        <RegisterFields
          webinar={w}
          account={account}
          onRegistered={onRegistered}
          onBack={onBack}
        />
      </div>
    );
  }

  return (
    <div>
      {onBack && <BackLink onBack={onBack} />}
      <WhenHeader webinar={w} title="Register & Join" />
      <p className="text-[13px] leading-relaxed text-ink-2">
        Registering {account.name} ({account.email}).
      </p>
      <div className="mt-3 h-24 animate-pulse rounded-xl bg-surface-2" />

      <Modal
        open={stage === "ask"}
        dismissible={false}
        onClose={() => {}}
        size="sm"
        title={`Share your mobile number with ${coach}`}
        description={`${coach} uses it for this webinar's join link and reminders.`}
      >
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <label className="label" htmlFor="consent-phone">
              Mobile number
            </label>
            <div className="flex gap-2">
              <select
                aria-label="Country calling code"
                className="field w-32 shrink-0"
                value={dialIso}
                onChange={(e) => setDialIso(e.target.value)}
              >
                {dials.map((d) => (
                  <option key={d.iso} value={d.iso}>
                    {d.label}
                  </option>
                ))}
              </select>
              <input
                id="consent-phone"
                className={`field min-w-0 flex-1 ${phoneError ? "border-live" : ""}`}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="98765 43210"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, "").slice(0, 15))}
                aria-invalid={Boolean(phoneError)}
              />
            </div>
            {phoneError && (
              <p className="text-[12px] font-medium text-live">{phoneError}</p>
            )}
          </div>
          <WhatsAppOptInCheckbox checked={optIn} onChange={setOptIn} coach={coach} />
          <Button type="submit" size="lg" className="w-full">
            Register &amp; Join
          </Button>
        </form>
      </Modal>
    </div>
  );
}

/* After Google, post the form that was saved before the redirect.
 *
 * The email is the account Google just confirmed, not whatever was typed, so
 * a different Google account still lands on a registration for that account.
 * A failure drops onto the form; the person is signed in, so the next submit
 * is the ordinary one.
 */
function ResumePendingRegister({
  webinar: w,
  account,
  draft,
  onRegistered,
}: {
  webinar: Webinar;
  account: Account;
  draft: RegisterRequest;
  onRegistered: (reg: Registration) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // The form was filled before Google: a typed phone and the WhatsApp box are the
  // person's own choice. Without a phone, ask for it (with WhatsApp) first.
  const draftHasPhone = Boolean(draft.phone?.trim());
  const base = useMemo<RegisterRequest>(() => {
    const name = splitName(account.name);
    return {
      ...draft,
      email: account.email,
      firstName: draft.firstName.trim() || name.firstName,
      lastName: draft.lastName.trim() || name.lastName,
    };
  }, [account, draft]);
  const clearDraft = useCallback(() => clearPendingWebinarRegister(w.id), [w.id]);

  useEffect(() => {
    if (!draftHasPhone || started.current) return;
    started.current = true;
    const name = splitName(account.name);
    api
      .register(w.id, {
        ...draft,
        email: account.email,
        firstName: draft.firstName.trim() || name.firstName,
        lastName: draft.lastName.trim() || name.lastName,
        phone: draft.phone || account.phone || "",
      })
      .then((reg) => {
        clearPendingWebinarRegister(w.id);
        onRegistered(reg);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not register.");
      });
  }, [account, draft, draftHasPhone, onRegistered, w.id]);

  if (!draftHasPhone) {
    return (
      <ConsentRegister
        webinar={w}
        account={account}
        base={base}
        onRegistered={onRegistered}
        onDone={clearDraft}
      />
    );
  }

  if (error) {
    return (
      <RegisterFields
        webinar={w}
        account={account}
        onRegistered={onRegistered}
      />
    );
  }

  return (
    <div>
      <WhenHeader webinar={w} title="Register & Join" />
      <p className="text-[13px] leading-relaxed text-ink-2">
        Registering {account.name} ({account.email}).
      </p>
      <div className="mt-3 h-24 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

function RegisterFields({
  webinar: w,
  account,
  onRegistered,
  onBack,
}: {
  webinar: Webinar;
  account: Account | null;
  onRegistered: (reg: Registration) => void;
  /** Absent when there was no choice to come back to. */
  onBack?: () => void;
}) {
  /* One name field, not two.
   *
   * "First name" and "Last name" were both required, which turns away anybody with a
   * mononym and asks everybody else to decide which half of their name is which. One field
   * is what a person can answer without thinking, and splitName below turns it into the
   * two columns the host's export has always had — so nothing downstream changes and the
   * greeting on the confirmation still reads "You're registered, Asha".
   */
  const [form, setForm] = useState(() => ({
    fullName: account?.name ?? "",
    email: account?.email ?? "",
    // India rather than the viewer's own locale: still fully editable, this
    // is only where it starts.
    country: "India",
  }));
  useEffect(() => {
    if (account?.email) return;
    const pending = readPendingWebinarRegister(w.id);
    if (!pending?.email) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage after mount */
    setForm((prev) => {
      if (prev.email) return prev;
      const pendingName = [pending.firstName, pending.lastName]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join(" ");
      return {
        ...prev,
        email: pending.email,
        fullName: prev.fullName || pendingName,
      };
    });
  }, [account?.email, w.id]);
  /* The number is two fields in the form and one value on the wire.
   *
   * Split here because that is how a person enters it — pick the country, type the number —
   * and joined on submit because E.164 is one string. Keeping the split all the way to the API
   * would make every reader reassemble it and every writer agree on how.
   *
   * Starts on India (+91) rather than the viewer's own locale, same reasoning
   * as `country` above — still just a starting value, changeable from the
   * same 200-country list as everyone else. */
  const [dialIso, setDialIso] = useState("IN");
  const [phoneNumber, setPhoneNumber] = useState(() =>
    nationalPhoneDigits(account?.phone ?? ""),
  );
  const dials = useMemo(() => dialOptions(), []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(true);
  /* WhatsApp updates start ticked. The person can still clear the box.
   *
   * Separate from the host-contact consent above: this is specifically WhatsApp
   * (confirmation, reminder, replay). It is only sent when a number is present.
   */
  const [whatsappOptIn, setWhatsappOptIn] = useState(true);
  /* Digits only, so "83 111 2222" and "+27 83 111 2222" agree on whether a number
   * was typed at all. Shared by the submit body and the opt-in box, which only
   * appears once there is a number for it to apply to. */
  const phoneDigits = phoneNumber.replace(/\D/g, "");
  /* Asked for only when the webinar has one, and the server never tells us what it is —
   * `passcodeRequired` is a boolean precisely so the code itself is not in this bundle. */
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { googleAuth } = useAppConfig();
  /* Instagram / Facebook / other app WebViews. The server snapshot is "not in one",
   * so the server HTML and the hydrating render agree; the client value follows. */
  const inApp = useSyncExternalStore(noSubscribe, currentInAppBrowser, () => null);
  const android = useSyncExternalStore(noSubscribe, currentIsAndroid, () => false);
  /* Our own mobile app: no "open in Chrome" note, but Google OAuth would leave the app for
   * the system browser, so it takes the email link like any other WebView. */
  const nativeApp = useSyncExternalStore(noSubscribe, currentIsNativeApp, () => false);
  const embedded = Boolean(inApp) || nativeApp;

  async function redirectGmail(body: RegisterRequest) {
    savePendingWebinarRegister(w.id, body);
    try {
      await startGoogleOAuth({
        next: `/webinars/${w.id}`,
        loginHint: body.email,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start Google sign-in.",
      );
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    if (!phoneDigits) {
      setFieldErrors({ phone: "Add a mobile number." });
      setBusy(false);
      return;
    }

    const { fullName, ...rest } = form;
    const body: RegisterRequest = {
      ...rest,
      ...splitName(fullName),
      /* `+<dial><national>`, with anything the person typed for legibility stripped.
       * Sending a bare "+91" for somebody who left it blank would store a country
       * code as a phone number. The server normalises again. */
      phone: `+${DIAL_CODES[dialIso] ?? ""}${phoneDigits}`,
      answers,
      consent,
      /* Never sent without a number: the server ignores it too, but an opt-in
       * that reaches the API unqualified would be a consent record pointing at
       * nothing — somebody in a broadcast audience nobody can reach. */
      whatsappOptIn: whatsappOptIn && phoneDigits !== "",
      passcode,
      /* Google refuses OAuth inside an app's WebView, so a Gmail address here takes
       * the email verification link instead (see handleRegister). */
      embeddedBrowser: embedded ? true : undefined,
    };

    /* Gmail on this public form signs in with Google instead of the password
     * signup or the verification link. The saved body is posted when they come
     * back, on this same webinar page. Anyone already signed in, and any other
     * domain, keeps the ordinary register call — that is the email verification
     * link, and it does not ask for a password. */
    if (!account && googleAuth && !embedded && isGmailAddress(body.email)) {
      await redirectGmail(body);
      return;
    }

    try {
      // The server validates too and is the authority — this call is the only
      // thing that actually creates a registration or a join key.
      const reg = await api.register(w.id, body);
      onRegistered(reg);
    } catch (err) {
      if (
        !account &&
        !embedded &&
        err instanceof ApiError &&
        err.code === "google_signin_required"
      ) {
        await redirectGmail(body);
        return;
      }
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        setError(err.fields ? "Some fields need attention." : err.message);
      } else {
        setError(
          "Could not reach the server. Check your connection and try again.",
        );
      }
      setBusy(false);
    }
  }

  const fieldError = (name: string) =>
    fieldErrors[name] ? (
      <p className="mt-1 text-[11.5px] font-medium text-live">
        {fieldErrors[name]}
      </p>
    ) : null;

  const full = w.registrantCount >= w.attendeeLimit;

  return (
    <form onSubmit={submit} noValidate>
      {onBack && <BackLink onBack={onBack} />}
      <WhenHeader webinar={w} title="Register & Join" />

      {full && (
        <div className="mb-3">
          <Alert tone="warn">
            This webinar has reached its seat limit. You can still submit a
            registration — the host may raise it.
          </Alert>
        </div>
      )}

      {inApp && <InAppBrowserNote app={inApp} android={android} />}

      {!account && (
        <div className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          Registering without an account is fine — your join link is saved in
          this browser.{" "}
          <Link
            href={`/signup?next=/webinars/${w.id}`}
            className="font-medium text-brand hover:underline"
          >
            Create an account
          </Link>{" "}
          to keep it across devices.
        </div>
      )}

      <div className="grid gap-3">
        <div>
          <label className="label" htmlFor="fullName">
            Full name
          </label>
          <input
            id="fullName"
            className="field"
            autoComplete="name"
            required
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
          {/* The server splits nothing and validates the first part, so a message about
              either half belongs on this one field. */}
          {fieldError("firstName") ?? fieldError("lastName")}
        </div>

        <div>
          <label className="label" htmlFor="email">
            Email Id
          </label>
          <input
            id="email"
            type="email"
            className="field"
            autoComplete="email"
            required
            placeholder="you@company.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {fieldError("email")}
        </div>

        <div>
          <label className="label" htmlFor="country">
            Country / region <span className="text-ink-3">(optional)</span>
          </label>
          <input
            id="country"
            className="field"
            autoComplete="country-name"
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
          />
        </div>

        {/* Mobile number, with the country code as a picker rather than something to remember.
            A single free-text field gets "9876543210" from most people and is then unusable:
            the host cannot dial a number whose country is a guess. The picker opens on the
            viewer's own country, so for most people it is already correct. */}
        <div>
          <label className="label" htmlFor="phone">
            Mobile number
          </label>
          <div className="flex gap-2">
            <select
              aria-label="Country calling code"
              className="field w-32 shrink-0"
              value={dialIso}
              onChange={(e) => setDialIso(e.target.value)}
            >
              {dials.map((d) => (
                <option key={d.iso} value={d.iso}>
                  {d.label}
                </option>
              ))}
            </select>
            <input
              id="phone"
              className="field min-w-0 flex-1"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="98765 43210"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              aria-invalid={Boolean(fieldErrors.phone)}
            />
          </div>
          {fieldError("phone")}
        </div>

        {/* host-defined questions */}
        {w.customQuestions.length > 0 && (
          <div className="mt-1 grid gap-3 border-t border-line pt-4">
            {w.customQuestions.map((q) => {
              const optional = !q.required && (
                <span className="text-ink-3"> (optional)</span>
              );
              const setAnswer = (v: string) =>
                setAnswers((a) => ({ ...a, [q.id]: v }));
              return (
                <div key={q.id}>
                  {q.type === "select" ? (
                    <fieldset>
                      <legend className="label">
                        {q.label}
                        {optional}
                      </legend>
                      <div className="grid gap-1.5">
                        {(q.options ?? []).map((o) => (
                          <label
                            key={o}
                            className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-2"
                          >
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              className="size-3.5 shrink-0 accent-brand"
                              value={o}
                              checked={answers[q.id] === o}
                              onChange={() => setAnswer(o)}
                            />
                            {o}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : q.type === "checkbox" ? (
                    <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink-2">
                      <input
                        id={`q-${q.id}`}
                        type="checkbox"
                        className="mt-0.5 size-3.5 shrink-0 accent-brand"
                        checked={answers[q.id] === CHECKBOX_YES}
                        onChange={(e) =>
                          setAnswer(e.target.checked ? CHECKBOX_YES : "")
                        }
                      />
                      <span>
                        {q.label}
                        {optional}
                      </span>
                    </label>
                  ) : (
                    <>
                      <label className="label" htmlFor={`q-${q.id}`}>
                        {q.label}
                        {optional}
                      </label>
                      <textarea
                        id={`q-${q.id}`}
                        className="field"
                        rows={2}
                        value={answers[q.id] ?? ""}
                        onChange={(e) => setAnswer(e.target.value)}
                      />
                    </>
                  )}
                  {fieldError(q.id)}
                </div>
              );
            })}
          </div>
        )}

        {/* The passcode gate.
            Shown only when the host set one. Not `type="password"`: this is a code the
            host read out on a call or pasted into an invite, and hiding it while somebody
            retypes it from a chat message only causes typos. */}
        {w.passcodeRequired && (
          <div>
            <label className="label" htmlFor="reg-passcode">
              Passcode
            </label>
            <input
              id="reg-passcode"
              className="input"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="From your invitation"
              aria-invalid={Boolean(fieldErrors.passcode)}
            />
            {fieldError("passcode")}
          </div>
        )}

        <label className="mt-1 flex items-start gap-2.5 text-[12px] leading-relaxed text-ink-2">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0 accent-brand"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            The host may contact me about this webinar.
            {w.options.autoRecord && " This session is recorded."}
          </span>
        </label>
        {fieldError("consent")}

        <WhatsAppOptInCheckbox
          checked={whatsappOptIn}
          onChange={setWhatsappOptIn}
        />

        {error && (
          <p role="alert" className="text-[12.5px] font-medium text-live">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy
            ? "Registering…"
            : w.priceUsd
              ? `Pay $${w.priceUsd} and register`
              : "Register & Join"}
        </Button>

        <p className="text-center text-[11.5px] text-ink-3">
          {account
            ? w.approval === "manual"
              ? "The host reviews each registration before approving."
              : "You'll get your join link straight away."
            : "We'll email you a link to confirm this address. Your join link arrives after that."}
        </p>
        <ExistingAccountSignIn webinarId={w.id} account={account} />
      </div>
    </form>
  );
}

function ExistingAccountSignIn({
  webinarId,
  account,
}: {
  webinarId: string;
  account: Account | null;
}) {
  if (account) return null;
  return (
    <p className="text-center text-[12.5px] text-ink-2">
      Already have an account?{" "}
      <Link
        href={webinarSignInHref(webinarId)}
        className="font-medium text-brand hover:underline"
      >
        Sign in
      </Link>
    </p>
  );
}

function Confirmed({
  webinar: w,
  registration: r,
}: {
  webinar: Webinar;
  registration: Registration;
}) {
  const origin = useShareOrigin();
  const { emailConfigured } = useAppConfig();
  const pending = r.state === "pending";
  const declined = r.state === "declined";
  const awaitingEmail = r.state === "unverified" || r.needsEmailVerification;
  const joinUrl = `${origin}/webinars/${w.id}/room`;

  const event = {
    title: w.topic,
    description: w.summary || w.description,
    startsAt: w.startsAt,
    durationMin: w.durationMin,
    url: joinUrl,
  };
  const ended = w.status === "ended";
  const canJoin = !pending && !declined && !awaitingEmail;

  return (
    <div>
      {/* Upcoming and live sessions lead with the way in. A finished session
          does not: the page heading says it has ended, and Join now stays a
          secondary action under the registration details. */}
      {canJoin && !ended && <JoinGate w={w} lead />}

      <div
        className={`mb-4 grid size-11 place-items-center rounded-full ${
          declined
            ? "bg-live-soft text-live"
            : pending || awaitingEmail
              ? "bg-warn-soft text-warn"
              : "bg-ok-soft text-ok"
        }`}
      >
        {pending || declined || awaitingEmail ? (
          <CalendarIcon className="size-5" />
        ) : (
          <CheckIcon className="size-5" />
        )}
      </div>

      <h2 className="text-[16px] font-semibold">
        {declined
          ? "Registration declined"
          : awaitingEmail
            ? "Check your email"
            : pending
              ? "Registration submitted"
              : `You're registered${r.firstName ? `, ${r.firstName}` : ""}`}
      </h2>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
        {declined ? (
          <>The host didn&apos;t approve this registration.</>
        ) : awaitingEmail ? (
          <>
            {r.message ||
              "Check your email to confirm this address. Your join link arrives after you verify."}{" "}
            The link works once. This page does not sign you in.
          </>
        ) : pending ? (
          <>
            The host reviews registrations for this webinar. Check back here —
            this page updates once you&apos;re approved.
          </>
        ) : (
          <>
            Your personal join link is below. Keep it: it is what gets you into
            the webinar.
            {emailConfigured
              ? " A confirmation with this link and a calendar invite is on its way to your inbox."
              : " This site is not sending email yet, so save the link here (and add it to your calendar below)."}
            {w.series
              ? " This registration covers every session in the series. Each one is listed in My webinars."
              : ""}
          </>
        )}
      </p>

      <dl className="my-4 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px]">
        <div className="flex justify-between gap-3 py-1">
          <dt className="text-ink-3">When</dt>
          <dd className="text-right">
            {formatDay(w.startsAt, w.timeZone)},{" "}
            {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
            {tzLabel(w.startsAt, w.timeZone)}
          </dd>
        </div>
        {/* No Webinar ID row either — same reason as the landing page. What a participant
            needs to get in is the join key below, which is theirs and nobody else's. */}
        {/* No passcode row. The attendee just typed it, and the API does not return it to
            anybody but the host — printing it back here is how a shared secret ends up in
            a screenshot of a confirmation page. */}
      </dl>

      {canJoin && (
        <>
          <div className="mb-3">
            <CopyField label="Your join key" value={r.joinKey} />
          </div>

          {/* Asked here, after registering, and only on a press: never on page load. */}
          {!ended && <PushOptIn joinKey={r.joinKey} meeting={w.kind === "meeting"} />}
          {!ended && <div className="mb-3" />}

          <div className="grid grid-cols-2 gap-2">
            <ButtonLink
              href={googleCalendarUrl(event)}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              size="sm"
            >
              Google Calendar
            </ButtonLink>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                downloadIcs(event, `${w.id}-${r.joinKey}`, `${w.id}.ics`)
              }
            >
              Download .ics
            </Button>
          </div>

          {/* A finished webinar keeps the door, but not as the thing the card
              is for. Upcoming and live put JoinGate above this block. */}
          {ended && (
            <ButtonLink
              href={`/webinars/${w.id}/room`}
              variant="secondary"
              className="mt-3 w-full"
            >
              Join now
            </ButtonLink>
          )}
        </>
      )}
    </div>
  );
}

/* Shown on the form when the page is open inside Instagram, Facebook or another app's
 * built-in browser. Registration still works there (Gmail falls back to the email
 * link), but the room plays better, and the join link stays saved, in the phone's own
 * browser. Android can be sent straight to Chrome; iOS has no such link, so it says
 * where the app keeps its "Open in browser" item. */
function InAppBrowserNote({ app, android }: { app: string; android: boolean }) {
  return (
    <div className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
      You&apos;re in {app}&apos;s built-in browser. For reliable sound and video,{" "}
      {android ? (
        <button
          type="button"
          onClick={() => window.location.assign(androidChromeIntent(window.location.href))}
          className="font-medium text-brand hover:underline"
        >
          open this page in Chrome
        </button>
      ) : (
        <>
          tap <b>•••</b> (or the share icon) and choose <b>Open in browser</b>
        </>
      )}
      .
    </div>
  );
}

/** The user agent never changes while the page is open: nothing to subscribe to. */
function noSubscribe(): () => void {
  return () => {};
}

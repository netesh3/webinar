"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useJoinKeyFor, useJoinKeys } from "./registrations";
import { Spinner } from "./controls";
import { useSession } from "./providers";
import { Button } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { MeetingKnockResponse } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { knockGoesIn, lobbyScreen, type LobbyScreen } from "@/lib/meeting-lobby";
import { meetingDoorFor } from "@/lib/meeting-room";

/* A meeting's front door, as the guest sees it: a name, then a wait.
 *
 * Nothing like a webinar's registration form, on purpose. A meeting has no audience and no
 * registrants (api/internal/api/meeting.go): somebody with the link says who they are and the
 * host lets them in or does not. So there is no email, no consent, no passcode — one field and
 * one button, "Ask to join".
 *
 * The knock answers with a join key, and the key is kept exactly where a webinar guest's is
 * (useJoinKeys, indexed by slug), because the rest of the way in is the same: the room page's
 * gate exchanges that key at POST /join, and for a meeting that exchange is also the waiting
 * room — 409 waiting_for_host until the host decides, a token once they have. That is why
 * this page sends the guest to the room as soon as they have knocked rather than waiting here:
 * the poll that finds them admitted is the same request that lets them in, with no second hop.
 *
 * A reload keeps their place. A browser holding a key knocks with it first, and the server
 * answers where it stands (waiting, admitted, denied) instead of queueing the same person
 * twice.
 *
 * Somebody signed in is not asked their name: the form knocks by itself with an empty name and
 * the server uses the account's (handleMeetingKnock). They still wait for the host. The host
 * who owns the meeting is sent to their own room instead (MeetingDoor).
 */

/** The name field and "Ask to join". Stores the key before calling onKnocked, so whatever
 *  the caller renders next already finds it. `joinKey` is the key a reload sends back; a
 *  fresh knock after a removal passes none, which is a new request the host can answer. */
export function MeetingKnockForm({
  slug,
  joinKey,
  onKnocked,
  onRefused,
  heading = "Ask to join",
}: {
  slug: string;
  joinKey?: string;
  onKnocked: (res: MeetingKnockResponse) => void;
  /** A refusal that is not a field error: denied, ended, locked, full. */
  onRefused: (screen: LobbyScreen) => void;
  heading?: string;
}) {
  const { add } = useJoinKeys();
  const { account, status } = useSession();
  const door = meetingDoorFor({ status, accountId: account?.id }, "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* The signed-in knock, once. It falls back to the form when it fails: the person can then
   * see why, and type a name if the account somehow has none. */
  const autoTried = useRef(false);
  const [autoFailed, setAutoFailed] = useState(false);

  function knock(asName: string): Promise<void> {
    return api
      .meetingKnock(slug, { name: asName, ...(joinKey ? { joinKey } : {}) })
      .then((res) => {
        if (res.joinKey) add(res.joinKey, slug);
        onKnocked(res);
      });
  }

  function failed(err: unknown) {
    if (err instanceof ApiError) {
      if (err.fields?.name) {
        setError(err.fields.name);
      } else {
        const s = lobbyScreen(err.code, err.message);
        if (s.phase === "knock" || s.phase === "error") setError(err.message || s.body);
        else onRefused(s);
      }
    } else {
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  useEffect(() => {
    if (door !== "auto" || autoTried.current) return;
    autoTried.current = true;
    knock("").catch((err: unknown) => {
      setAutoFailed(true);
      failed(err);
    });
    // Once, when the session says who this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [door]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Tell the host who you are.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await knock(name);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  }

  if (door === "wait" || (door === "auto" && !autoFailed)) {
    return (
      <div className="flex flex-col items-center gap-3 py-6" role="status">
        <Spinner className="size-5 text-ink-3" />
        <p className="text-[13.5px] text-ink-2">
          {door === "wait" ? "One moment…" : "Asking the host to let you in…"}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 text-left">
      <h2 className="text-[17px] font-semibold">{heading}</h2>
      <div>
        <label className="label" htmlFor="meeting-name">
          Your name
        </label>
        <input
          id="meeting-name"
          className="field"
          autoComplete="name"
          autoFocus
          required
          maxLength={60}
          placeholder="How you'll appear to everyone"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={Boolean(error)}
        />
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] font-medium text-live">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
        {busy && <Spinner className="size-4" />}
        {busy ? "Asking…" : "Ask to join"}
      </Button>
      <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
        No sign-up needed. The host will let you in. Your microphone starts muted.
      </p>
    </form>
  );
}

/** One of the lobby's answers as a card body: waiting (with a spinner), or a refusal with
 *  whatever the screen allows next. Shared by this page and the room gate. */
export function LobbyStatus({
  screen,
  onRetry,
  onKnockAgain,
  backHref,
}: {
  screen: LobbyScreen;
  onRetry?: () => void;
  onKnockAgain?: () => void;
  backHref?: string;
}) {
  return (
    <div className="grid gap-2 text-center" role="status" aria-live="polite">
      {screen.poll && (
        <div className="mb-1 flex justify-center">
          <Spinner className="size-5 text-ink-3" />
        </div>
      )}
      <h1 className="text-[17px] font-semibold">{screen.title}</h1>
      {screen.body ? (
        <p className="text-[13.5px] leading-relaxed text-ink-2">{screen.body}</p>
      ) : null}
      {(screen.retry && onRetry) || (screen.knockAgain && onKnockAgain) || backHref ? (
        <div className="mt-3 grid gap-2">
          {screen.retry && onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
          {screen.knockAgain && onKnockAgain ? (
            <Button onClick={onKnockAgain}>Ask to join again</Button>
          ) : null}
          {backHref ? (
            <a href={backHref} className="text-[12.5px] text-brand hover:underline">
              Back to the meeting page
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The landing page's door for a meeting. */
export function MeetingDoor({ slug, hostId }: { slug: string; hostId: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { account, status } = useSession();
  // The host's own meeting: they run it from the host room, not from the lobby.
  const ownMeeting = meetingDoorFor({ status, accountId: account?.id }, hostId) === "host";
  useEffect(() => {
    if (ownMeeting) router.replace(`/host/${slug}/room`);
  }, [ownMeeting, router, slug]);
  const storedKey = useJoinKeyFor(slug);
  // "checking" until a held key has been asked about; then the form, a refusal, or "going".
  const [view, setView] = useState<
    { kind: "checking" } | { kind: "form"; fresh: boolean } | { kind: "screen"; screen: LobbyScreen } | { kind: "going" }
  >({ kind: "checking" });
  const asked = useRef(false);

  const enter = (res: MeetingKnockResponse) => {
    if (!knockGoesIn(res.state)) return;
    setView({ kind: "going" });
    router.push(`/webinars/${slug}/room`);
  };

  /* A browser that already knocked asks where it stands, with no name: the key is checked
   * before the name on the server. An unknown key comes back as a name error, which is the
   * form — and is not shown as one, since the guest has typed nothing yet. */
  useEffect(() => {
    if (!hydrated || asked.current) return;
    asked.current = true;
    if (!storedKey) {
      queueMicrotask(() => setView({ kind: "form", fresh: false }));
      return;
    }
    api
      .meetingKnock(slug, { name: "", joinKey: storedKey })
      .then(enter)
      .catch((err: unknown) => {
        if (err instanceof ApiError && !err.fields) {
          const s = lobbyScreen(err.code, err.message);
          if (s.phase !== "knock" && s.phase !== "error") {
            setView({ kind: "screen", screen: s });
            return;
          }
        }
        setView({ kind: "form", fresh: false });
      });
    // Once, for the key this page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  if (ownMeeting || view.kind === "checking" || view.kind === "going") {
    return (
      <div className="flex flex-col items-center gap-3 py-6" role="status">
        <Spinner className="size-5 text-ink-3" />
        <p className="text-[13.5px] text-ink-2">
          {ownMeeting
            ? "Opening your meeting…"
            : view.kind === "going"
              ? "Taking you to the meeting…"
              : "One moment…"}
        </p>
      </div>
    );
  }
  if (view.kind === "screen") {
    return (
      <LobbyStatus
        screen={view.screen}
        onRetry={() => setView({ kind: "form", fresh: false })}
        onKnockAgain={() => setView({ kind: "form", fresh: true })}
      />
    );
  }
  return (
    <MeetingKnockForm
      slug={slug}
      // A held key the server did not recognise is no use to send again; one it did is
      // already answered above. Only a fresh knock after a removal drops it explicitly.
      joinKey={view.fresh ? undefined : (storedKey ?? undefined)}
      onKnocked={enter}
      onRefused={(screen) => setView({ kind: "screen", screen })}
    />
  );
}

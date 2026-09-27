"use client";

import {
  useLocalParticipant,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, Track, type Participant, type Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { LiveParticipant, LiveRoom, Role } from "@/lib/api-types";
import type { Realtime } from "@/lib/realtime";
import {
  handWaitLabel,
  matchRosterQuery,
  partitionHostRoster,
  rosterBadge,
  shouldShowRosterSearch,
  withLocalOnRoster,
} from "@/lib/roster";
import { useToast } from "../providers";
import { IconButton, Menu, Spinner } from "../controls";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeOffIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  SearchIcon,
  TrashIcon,
  UsersIcon,
} from "../icons";
import { SenderAvatar } from "../sender-avatar";
import { Pill, RoleBadge } from "./chat-badges";
import { useRoomUI } from "./context";

/* The participants panel.
 *
 * Two different data sources, for one reason: when the host hides the audience,
 * the SFU stops sending those participant records to every client — including the
 * host's. So the host's roster is fetched from our API, which reads LiveKit's
 * server-side list and does include hidden participants. Everyone else sees only
 * what their own connection knows about, which is exactly the privacy guarantee.
 */

/** Reads the role we minted into the participant's token metadata.
 *
 *  Metadata rather than the identity prefix: a promoted attendee keeps their
 *  att_ identity but is genuinely a panelist, and classifying on the prefix would
 *  keep showing them as audience.
 *
 *  `self` is the join record for this browser. The local LiveKit participant
 *  often has empty metadata for a few beats after connect, and the permission
 *  fallback then files a panelist as an attendee — so they vanish from
 *  Panelists, and disappear entirely when the host has hidden the audience. */
export function participantRole(
  p: Participant,
  self?: { identity: string; role: Role },
): Role {
  if (
    self &&
    (p.isLocal || p.identity === self.identity) &&
    (self.role === "host" || self.role === "panelist" || self.role === "attendee")
  ) {
    return self.role;
  }
  if (p.metadata) {
    try {
      const parsed = JSON.parse(p.metadata) as { role?: string };
      if (parsed.role === "host" || parsed.role === "panelist" || parsed.role === "attendee") {
        return parsed.role;
      }
    } catch {
      // Not ours, or truncated. Fall through to the permission check.
    }
  }
  return p.permissions?.canPublish ? "panelist" : "attendee";
}

/** The baseline refresh, when nothing has told us to look sooner.
 *
 *  Polling rather than a socket: this is one request per host, not per attendee,
 *  and it is the only way to see hidden participants at all — a host's own LiveKit
 *  connection never learns about somebody the room is hiding from them, so no
 *  client-side event can stand in for this fully. Five seconds is the fallback
 *  cadence for that hidden-only case; anything a host's own connection DOES see
 *  (below) reads far sooner than this. */
const ROSTER_POLL_MS = 5000;

/** How soon to look again after a request failed. Short enough that "couldn't
 *  refresh" is a blip rather than a five-second stretch of a stale headcount,
 *  long enough that a genuinely down SFU is not hammered every tick. */
const ROSTER_RETRY_MS = 1500;

/** How long to wait for a burst of LiveKit events to settle before reading. A join
 *  fires ParticipantConnected and then a TrackPublished per track moments later —
 *  one read for the whole burst, not one per event. */
const ROSTER_DEBOUNCE_MS = 400;

export function useHostRoster(slug: string, enabled: boolean, room: Room | null) {
  const [live, setLive] = useState<LiveRoom | null>(null);
  const [error, setError] = useState(false);
  // Guards against a slow response overlapping the next tick, which on a bad
  // connection would queue requests faster than they complete.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setLive(await api.participants(slug));
      setError(false);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
    }
  }, [slug]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    // Self-rescheduling rather than setInterval, so a failure can come back sooner
    // than a success does, and an event below can pull the next read forward
    // instead of waiting out whatever is left of the baseline five seconds.
    const read = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      api
        .participants(slug)
        .then((snapshot) => {
          if (!active) return;
          setLive(snapshot);
          setError(false);
          schedule(ROSTER_POLL_MS);
        })
        .catch(() => {
          if (!active) return;
          setError(true);
          schedule(ROSTER_RETRY_MS);
        })
        .finally(() => {
          inFlight.current = false;
        });
    };

    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      timer = setTimeout(read, delayMs);
    };

    // Pulls the next read forward to right after the debounce window, rather than
    // however much of the baseline interval happens to be left — a join a moment
    // after a successful read used to wait up to five seconds for the count to
    // catch up, which is what read like a wrong number rather than a stale one.
    const soon = () => schedule(ROSTER_DEBOUNCE_MS);

    read();

    // Everything a host's own LiveKit connection already learns in real time:
    // somebody joining or leaving, a mic/camera track starting or stopping (moved
    // to/from the stage, or just published a moment after connecting), and a
    // permission change (promoted, muted, made co-host). All of it still has to
    // go through the server for the actual row data — this only decides when to
    // ask again instead of waiting for the next scheduled tick.
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantPermissionsChanged,
      RoomEvent.ParticipantMetadataChanged,
    ] as const;
    for (const event of events) room?.on(event, soon);

    return () => {
      active = false;
      clearTimeout(timer);
      for (const event of events) room?.off(event, soon);
    };
  }, [enabled, slug, room]);

  // Memoised because this value goes into the room context. A fresh object every
  // render would bust that memo and re-render every panel, the stage and the control
  // bar on each of them — the exact cost the context was arranged to avoid.
  return useMemo(() => ({ live, error, reload: load }), [live, error, load]);
}

export function ParticipantsPanel() {
  const { isHost } = useRoomUI();
  return isHost ? <HostRoster /> : <AudienceRoster />;
}

/** Moves somebody on or off the stage and settles their raised hand to match. The
 *  one path for the roster row and the raised-hand toast (hand-toasts.tsx), so the
 *  two cannot drift. Returns "invited" when the server sent an invite rather than
 *  granting outright — the hand then stays up until they accept. */
export async function setStageSettlingHand(
  slug: string,
  lowerHand: Realtime["lowerHand"],
  identity: string,
  role: Role,
  audioOnly: boolean,
  handUp: boolean,
): Promise<"invited" | "done"> {
  const res = await api.setStage(slug, identity, role, audioOnly);
  // An invite is still pending — leave the hand up. Lowering it as "granted" used
  // to remount CDN attendees onto WebRTC before they had publish permission (or a
  // consent dialog).
  if (res.status === "invited") return "invited";
  if (handUp) await lowerHand(identity, role === "panelist" ? "granted" : "dismissed");
  return "done";
}

// ---------------------------------------------------------------- host view

function HostRoster() {
  const { slug, join, realtime, roster } = useRoomUI();
  const { localParticipant } = useLocalParticipant();
  const { notify } = useToast();
  // From the context rather than a poll of its own: the control bar needs the same
  // headcount for its badge whether or not this panel is open, and two five-second
  // polls of the same endpoint is one too many.
  const { live, error, reload } = roster;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const handIdentities = useMemo(
    () => new Map(realtime.hands.map((h) => [h.identity, h.at])),
    [realtime.hands],
  );

  // The queue's clock, for "waiting 3 min". Ticks only while somebody's hand is up,
  // and only every half minute: the label is whole minutes, and a roster that
  // re-rendered every second for it would be paying for nothing.
  const [now, setNow] = useState(() => Date.now());
  const anyHands = realtime.hands.length > 0;
  useEffect(() => {
    if (!anyHands) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anyHands]);

  // `label` is what usually gets said; an action that learns something more
  // specific from the response returns its own string instead.
  const act = useCallback(
    async (identity: string, label: string, run: () => Promise<string | void>) => {
      setBusy(identity);
      try {
        const outcome = await run();
        notify(outcome ?? label, "ok");
        await reload();
      } catch (err) {
        notify(err instanceof Error ? err.message : "That didn't work.", "error");
      } finally {
        setBusy(null);
      }
    },
    [notify, reload],
  );

  const matching = useMemo(() => {
    const rows = withLocalOnRoster(live?.participants ?? [], {
      identity: join.identity,
      name: join.displayName,
      role: join.role,
    });
    return rows.filter((p) => matchRosterQuery(p, query));
  }, [live, query, join.identity, join.displayName, join.role]);

  // Faces for the header, off the whole roster rather than `matching`, so typing
  // in the search box does not change who the summary says is on stage.
  const stageFaces = useMemo(() => {
    const rows = withLocalOnRoster(live?.participants ?? [], {
      identity: join.identity,
      name: join.displayName,
      role: join.role,
    });
    return rows
      .filter((p) => p.role !== "attendee")
      .sort((a, b) => Number(b.role === "host") - Number(a.role === "host"))
      .slice(0, 3)
      .map((p) => ({ name: p.name || p.identity, identity: p.identity }));
  }, [live, join.identity, join.displayName, join.role]);

  const sections = useMemo(
    () => partitionHostRoster(matching, realtime.hands),
    [matching, realtime.hands],
  );

  const showSearch = shouldShowRosterSearch(live?.participants.length ?? 0, query);

  const empty =
    sections.raised.length + sections.panelists.length + sections.attendees.length === 0;

  // The counts, the search box and Mute all render straight away and only
  // the list waits. Replacing the whole panel with a spinner meant every open —
  // and every one of the five-second refreshes — flashed the chrome away.
  const loading = !live && !error;

  const row = (p: LiveParticipant) => (
    <HostRosterRow
      key={p.identity}
      participant={p}
      isMe={p.identity === join.identity}
      handRaised={handIdentities.has(p.identity)}
      handRaisedAt={handIdentities.get(p.identity)}
      now={now}
      busy={busy === p.identity}
      onMute={(muted) =>
        p.identity === join.identity
          ? // Your own row. Toggled locally, because a microphone can
            // only be switched on by the browser it belongs to — and
            // that is this one.
            act(
              p.identity,
              muted ? "You're muted" : "You're unmuted",
              async () => {
                await localParticipant.setMicrophoneEnabled(!muted);
              },
            )
          : act(
              p.identity,
              muted
                ? `Muted ${p.name} — they can't unmute themselves`
                : `${p.name} can speak again`,
              async () => {
                const res = await api.muteParticipant(slug, p.identity, muted);
                // The permission is back, but only their own browser can
                // open a microphone, so say what still has to happen.
                if (res.status === "allowed") {
                  return `${p.name} can speak again — they need to unmute themselves`;
                }
              },
            )
      }
      // A server cannot start somebody's microphone — only their own
      // browser can. When they have permission but no live track, the
      // honest action is to ask them.
      onAskToUnmute={() =>
        act(p.identity, `Asked ${p.name} to unmute`, () =>
          realtime.askToUnmute(p.identity),
        )
      }
      onStage={(role, audioOnly) =>
        act(
          p.identity,
          role !== "panelist"
            ? `${p.name} is muted and back in the audience`
            : audioOnly
              ? `Waiting for ${p.name} to accept`
              : `Waiting for ${p.name} to join the stage`,
          async () => {
            await setStageSettlingHand(
              slug,
              realtime.lowerHand,
              p.identity,
              role,
              audioOnly,
              handIdentities.has(p.identity),
            );
          },
        )
      }
      onDismissHand={() =>
        act(p.identity, `Dismissed ${p.name}'s request`, () =>
          realtime.lowerHand(p.identity, "dismissed"),
        )
      }
      onRemove={() =>
        act(p.identity, `Removed ${p.name}`, async () => {
          await api.removeParticipant(slug, p.identity);
        })
      }
      onSetCoHost={(coHost) =>
        act(
          p.identity,
          coHost
            ? `${p.name} can now control the webinar like you can.`
            : `${p.name} is back to an ordinary panelist.`,
          async () => {
            // A panelist's identity is "user_<id>" — see hostIdentity on
            // the API side — so this is the one place the id has to be
            // recovered from it, for the endpoint that takes it plain.
            const userID = p.identity.replace(/^user_/, "");
            await api.setCoHost(slug, userID, coHost);
          },
        )
      }
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2.5 border-b border-line px-3 py-3">
        {/* One row: who is here on the left, the room-wide action on the right.
            The "Hidden" chip that used to sit here was only an indicator of the
            hide-attendees privacy setting, which is toggled in Host controls. */}
        <div className="@container flex items-center gap-2">
          <RosterStats onStage={live?.onStage ?? 0} attending={live?.attendees ?? 0} faces={stageFaces} />
          <button
            type="button"
            onClick={() => {
              void (async () => {
                setBusy("mute-all");
                try {
                  const { muted } = await api.muteAll(slug);
                  notify(
                    muted === 0
                      ? "Nobody had an open microphone."
                      : `Muted ${muted} ${muted === 1 ? "microphone" : "microphones"}.`,
                    "ok",
                  );
                  await reload();
                } catch (err) {
                  notify(err instanceof Error ? err.message : "That didn't work.", "error");
                } finally {
                  setBusy(null);
                }
              })();
            }}
            disabled={busy !== null}
            aria-busy={busy === "mute-all"}
            title="Mute everyone except you"
            aria-label="Mute everyone except you"
            // 32px to look at, 44px to hit on touch — the header is one line and a
            // full-height touch button would make it the tallest thing in it.
            className="relative ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-2 px-2 text-[12px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-[''] @[17rem]:px-2.5 md:h-7"
          >
            {busy === "mute-all" ? (
              <Spinner className="size-3.5" />
            ) : (
              <MicOffIcon className="size-3.5" />
            )}
            {/* Icon-only when the row is too narrow for the words. */}
            <span className="hidden @[17rem]:inline">Mute all</span>
          </button>
        </div>

        {/* The queue, and the one action that clears it.

            Shown here rather than only per-row because a host who has finished taking
            questions wants to move on, not to dismiss eleven people one at a time.
            Each row still has its own "Lower Hand" for passing over one person. */}
        {realtime.hands.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-2.5 py-1.5">
            <HandIcon className="size-3.5 shrink-0 text-warn" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-warn">
              {realtime.hands.length} {realtime.hands.length === 1 ? "hand" : "hands"} raised
            </span>
            <button
              type="button"
              onClick={() => {
                const count = realtime.hands.length;
                void realtime.clearHands();
                notify(`Lowered ${count} ${count === 1 ? "hand" : "hands"}.`, "ok");
              }}
              className="shrink-0 min-h-11 rounded-md px-2.5 text-[11.5px] font-medium text-warn transition-colors hover:bg-warn/15 outline-none focus-visible:ring-2 focus-visible:ring-warn/40 md:min-h-0 md:py-0.5"
            >
              Lower All Hands
            </button>
          </div>
        )}

        {showSearch && (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            {/* text-base on a phone so iOS does not zoom the field to 16px and
                cover the list with the on-screen keyboard's chrome. */}
            <input
              className="field h-11 pl-8 text-base md:h-8 md:text-[12.5px]"
              placeholder="Search participants"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search participants"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
        )}

        {error && (
          <p className="text-[11.5px] text-live">
            Couldn&apos;t refresh the list. Retrying…
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-ink-3" />
          </div>
        ) : empty ? (
          <p className="px-3 py-8 text-center text-[12.5px] text-ink-3">
            {query ? "Nobody matches that." : "Nobody has joined yet."}
          </p>
        ) : (
          <>
            {sections.raised.length > 0 && (
              <Group title="Raised hands" count={sections.raised.length}>
                {sections.raised.map(row)}
              </Group>
            )}
            <Group title="Panelists" count={sections.panelists.length}>
              {sections.panelists.length === 0 ? (
                <li className="px-3 py-4 text-[12.5px] text-ink-3">
                  Nobody on the stage.
                </li>
              ) : (
                sections.panelists.map(row)
              )}
            </Group>
            <Group title="Attendees" count={sections.attendees.length}>
              {sections.attendees.length === 0 ? (
                <li className="px-3 py-4 text-[12.5px] text-ink-3">
                  {query ? "No attendees match that." : "No attendees yet."}
                </li>
              ) : (
                sections.attendees.map(row)
              )}
            </Group>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One row of the host's roster, and the four states that matter.
 *
 *   audience          → "Allow to speak" (a microphone and a screen share, but
 *                       no camera) or a full stage seat; plus "Dismiss
 *                       request" if their hand is up
 *   allowed to speak  → mute, or ask them to unmute if they have not opened a
 *                       microphone yet
 *   muted by the host → "Allow to speak again", which is the only way back: the
 *                       microphone is out of their grant, so they cannot undo it
 *   on the stage      → the same, plus "Remove speaker permission"
 *
 * The mute control is deliberately keyed on `canSpeak` rather than on the role.
 * Keying it on the role is what made "unmute the attendee" impossible: an
 * ordinary attendee has no microphone track to unmute and never can, so the
 * button either wasn't there or returned an error.
 */
function HostRosterRow({
  participant: p,
  isMe,
  handRaised,
  handRaisedAt,
  now,
  busy,
  onMute,
  onAskToUnmute,
  onStage,
  onDismissHand,
  onRemove,
  onSetCoHost,
}: {
  participant: LiveParticipant;
  isMe: boolean;
  handRaised: boolean;
  /** When the hand went up, for the queue's "waiting 3 min". */
  handRaisedAt?: number;
  now: number;
  busy: boolean;
  onMute: (muted: boolean) => void;
  onAskToUnmute: () => void;
  onStage: (role: Role, audioOnly: boolean) => void;
  onDismissHand: () => void;
  onRemove: () => void;
  onSetCoHost: (coHost: boolean) => void;
}) {
  const isHost = p.role === "host";
  const sharing = p.publishing.some((t) => t.includes("SCREEN_SHARE"));
  const hasMic = p.publishing.some((t) => t.includes("MICROPHONE"));
  // Permission to speak, which an attendee the host allowed to speak now has even
  // though their role is still shown as audience-adjacent.
  const canSpeak = p.canSpeak;
  // Silenced by the host, as opposed to never having been a speaker. Both have
  // canSpeak false and they need opposite actions offered.
  const silenced = p.mutedByHost && !isHost;
  // The scope of the grant, as the host set it — not guessed from what they are
  // publishing, which would call a panelist with their camera off "audio only".
  const speakingOnly = p.role === "panelist" && !isHost && p.audioOnly;
  const onStageNow = p.role === "panelist" && !isHost;
  // Co-host needs an account behind the identity (see handleSetCoHost on the
  // API side) — a panelist invited from the panelist list has one ("user_"
  // identity); an attendee the host brought up on stage does not ("att_"
  // identity), no matter that both show up as "Panelist" in this same list.
  // Gating the menu item on the prefix means the rare mis-click never reaches
  // the server at all, instead of surfacing as a confusing error toast.
  const canBeCoHost = onStageNow && p.identity.startsWith("user_");
  const badge = rosterBadge(p);

  return (
    <li
      className={`flex min-h-12 items-center gap-2.5 px-3 py-2 ${
        handRaised ? "bg-warn/[0.05]" : isMe ? "bg-brand/[0.05]" : ""
      }`}
    >
      <SenderAvatar name={p.name || p.identity} identity={p.identity} ring={p.role !== "attendee"} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">
            {p.name || p.identity}
          </span>
          {/* Your own name stays — it is how you check what everyone else sees you
              as — with "You" beside it, as the chat and Q&A put it. */}
          {isMe && <span className="shrink-0 text-[11px] text-ink-3">(You)</span>}
          {badge && <Pill tone={badge.tone}>{badge.label}</Pill>}
          {handRaised && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/25 bg-warn-soft px-1.5 text-[10px] leading-4 font-semibold text-warn">
              <HandIcon className="size-2.5" />
              {handRaisedAt !== undefined ? handWaitLabel(handRaisedAt, now) : "Hand"}
              <span className="sr-only"> — hand raised</span>
            </span>
          )}
        </span>
        {/* What they are doing right now. The role that used to open this line is
            the badge above; an attendee with nothing going on gets no second line. */}
        {(sharing || silenced || canSpeak) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-3">
            {sharing && <span className="text-brand">Sharing screen</span>}
            {silenced && <span className="text-warn">Muted by you</span>}
            {canSpeak && hasMic && !p.audioMuted && <span className="text-ok">Live</span>}
            {canSpeak && hasMic && p.audioMuted && <span>Mic off</span>}
            {canSpeak && !hasMic && <span>Hasn&apos;t unmuted</span>}
          </span>
        )}

        {/* A raised hand is time-sensitive — one click each, not buried behind
            the overflow menu everything else lives in. Under the name rather than
            beside it, so the two buttons never squeeze the name out of a 360px
            panel. Attendee-only: a panelist/co-host raising a hand (rare, but the
            control isn't role-gated) still gets "Lower Hand" from the menu below,
            since "Allow to speak" makes no sense for someone already on stage. */}
        {!busy && handRaised && p.role === "attendee" && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onStage("panelist", true)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand px-3 text-[12.5px] font-medium text-stage transition-colors hover:bg-brand-hover outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 md:py-0"
            >
              Allow to Speak
            </button>
            <button
              type="button"
              onClick={onDismissHand}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line-2 px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 md:py-0"
            >
              Lower Hand
            </button>
          </span>
        )}
      </span>

      {busy ? (
        <Spinner className="size-4 text-ink-3" />
      ) : (
        <>
          {silenced ? (
            // The one-click way back. Nothing they can do restores it themselves,
            // which is the point of the mute — so the host needs it in reach.
            <IconButton
              label={`Allow ${p.name} to speak again`}
              className="size-11 md:size-8"
              onClick={() => onMute(false)}
            >
              <MicOffIcon className="size-4 text-warn" />
            </IconButton>
          ) : (
            canSpeak &&
            (isMe ? (
              // Your own microphone, toggled in your own browser. The server route
              // cannot switch a microphone back on — the SFU refuses that by
              // design — and it does not need to for the person sitting here.
              <IconButton
                label={p.audioMuted ? `Unmute ${p.name}` : `Mute ${p.name}`}
                className="size-11 md:size-8"
                onClick={() => onMute(!p.audioMuted)}
              >
                {p.audioMuted ? (
                  <MicOffIcon className="size-4 text-ink-3" />
                ) : (
                  <MicIcon className="size-4 text-ok" />
                )}
              </IconButton>
            ) : hasMic && !p.audioMuted ? (
              <IconButton label={`Mute ${p.name}`} className="size-11 md:size-8" onClick={() => onMute(true)}>
                <MicIcon className="size-4 text-ok" />
              </IconButton>
            ) : (
              // Already silent. Only their own browser can open a microphone —
              // whether there is no track yet or a muted one, the SFU will not
              // switch it on from here, and that protection is worth having. So
              // the button asks instead of pretending to do it.
              <IconButton
                label={`Ask ${p.name} to unmute`}
                className="size-11 md:size-8"
                onClick={onAskToUnmute}
              >
                <MicOffIcon className="size-4 text-warn" />
              </IconButton>
            ))
          )}

          <Menu
            label={`Actions for ${p.name}`}
            align="end"
            trigger={
              <span className="grid size-11 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink md:size-8">
                <MoreIcon className="size-4" />
              </span>
            }
            items={[
              ...(p.role === "attendee"
                ? [
                    // Suppressed when handRaised: the row already has this as a
                    // prominent button above, and offering the same action twice
                    // on one row is clutter, not a second path anyone needs.
                    ...(handRaised
                      ? []
                      : [
                          {
                            kind: "action" as const,
                            label: "Allow to speak",
                            hint: "mic and screen share",
                            icon: <MicIcon className="size-4" />,
                            onSelect: () => onStage("panelist", true),
                          },
                        ]),
                    {
                      kind: "action" as const,
                      label: "Bring on stage",
                      hint: "camera, mic, and screen share",
                      icon: <ArrowUpIcon className="size-4" />,
                      onSelect: () => onStage("panelist", false),
                    },
                  ]
                : []),
              // Answering a raised hand without granting anything. Broadcast, so
              // their own hand comes down rather than staying up in a queue they
              // have already been passed over in. Attendee rows get this as a
              // prominent "Lower Hand" button above instead — this menu item is
              // the fallback for the rare non-attendee hand-raise (role isn't
              // gated on the control), so it isn't offered twice for the same row.
              ...(handRaised && p.role !== "attendee"
                ? [
                    {
                      kind: "action" as const,
                      label: "Lower Hand",
                      hint: "lowers their hand",
                      icon: <HandIcon className="size-4" />,
                      onSelect: onDismissHand,
                    },
                  ]
                : []),
              ...(silenced
                ? [
                    {
                      kind: "action" as const,
                      label: "Allow to speak again",
                      icon: <MicIcon className="size-4" />,
                      onSelect: () => onMute(false),
                    },
                  ]
                : []),
              // A promoted attendee can be widened to a full seat, or narrowed
              // back to just a microphone, without dropping them to the audience.
              ...(onStageNow && speakingOnly
                ? [
                    {
                      kind: "action" as const,
                      label: "Also allow video",
                      icon: <ArrowUpIcon className="size-4" />,
                      onSelect: () => onStage("panelist", false),
                    },
                  ]
                : []),
              ...(onStageNow && !speakingOnly
                ? [
                    {
                      kind: "action" as const,
                      label: "Audio only",
                      icon: <MicIcon className="size-4" />,
                      onSelect: () => onStage("panelist", true),
                    },
                  ]
                : []),
              ...(onStageNow
                ? [
                    {
                      kind: "action" as const,
                      // Named for what it takes away. "Move to audience" reads as
                      // a seating change; this mutes them and ends their turn.
                      label: "Remove speaker permission",
                      hint: "back to the audience",
                      icon: <ArrowDownIcon className="size-4" />,
                      onSelect: () => onStage("attendee", false),
                    },
                  ]
                : []),
              // Full parity with the host, for this one webinar. See
              // canBeCoHost above for why this is withheld from a promoted
              // attendee even though they read as "Panelist" too.
              ...(canBeCoHost
                ? [
                    {
                      kind: "action" as const,
                      label: p.coHost ? "Remove co-host" : "Make co-host",
                      hint: p.coHost
                        ? "back to an ordinary panelist"
                        : "full control, same as you",
                      icon: <ArrowUpIcon className="size-4" />,
                      onSelect: () => onSetCoHost(!p.coHost),
                    },
                  ]
                : []),
              ...(isMe || isHost
                ? []
                : [
                    { kind: "separator" as const },
                    {
                      kind: "action" as const,
                      label: "Remove from webinar",
                      icon: <TrashIcon className="size-4" />,
                      danger: true,
                      onSelect: onRemove,
                    },
                  ]),
            ]}
          />
        </>
      )}
    </li>
  );
}

// ------------------------------------------------------------ audience view

/**
 * What an attendee or panelist sees.
 *
 * Built from this client's own participant list, so it can only ever show people
 * the SFU chose to tell us about. When the host hides the audience, that is the
 * stage and nobody else — and the count comes from the host's own announcement
 * rather than from anything we could enumerate.
 */
function AudienceRoster() {
  const { controls, join } = useRoomUI();
  const room = useRoomContext();
  const participants = useParticipants();
  const [query, setQuery] = useState("");
  const self = { identity: join.identity, role: join.role };
  const roleOf = (p: Participant) => participantRole(p, self);

  const stage = useMemo(
    () =>
      participants
        .filter((p) => roleOf(p) !== "attendee")
        .filter((p) =>
          matchRosterQuery({ name: p.name || p.identity, identity: p.identity }, query),
        )
        .sort((a, b) => {
          const rank = (p: Participant) => {
            if (roleOf(p) === "host") return 0;
            if (p.identity === join.identity || p.isLocal) return 1;
            return 2;
          };
          return rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? "");
        }),
    [participants, query, join.identity, join.role],
  );

  // Other attendees are withheld when the host hid the audience. You still see
  // yourself: Zoom lists (Me) even then, and a panel that hides the person
  // looking at it is a panel that looks broken.
  const audience = useMemo(
    () =>
      participants
        .filter((p) => roleOf(p) === "attendee")
        .filter((p) => {
          const mine = p.identity === join.identity || p.isLocal;
          if (controls.hideAttendees && !mine) return false;
          return true;
        })
        .filter((p) =>
          matchRosterQuery({ name: p.name || p.identity, identity: p.identity }, query),
        ),
    [participants, controls.hideAttendees, query, join.identity, join.role],
  );

  const showSearch = shouldShowRosterSearch(participants.length, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch && (
        <div className="shrink-0 border-b border-line px-3 py-2.5">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            <input
              className="field h-11 pl-8 text-base md:h-8 md:text-[12.5px]"
              placeholder="Search participants"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search participants"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Group title="Panelists" count={stage.length}>
        {stage.map((p) => (
          <AudienceRow
            key={p.identity}
            name={p.name || p.identity}
            identity={p.identity}
            role={roleOf(p)}
            isMe={p.identity === join.identity || p.isLocal}
            muted={!p.getTrackPublication(Track.Source.Microphone) ||
              !!p.getTrackPublication(Track.Source.Microphone)?.isMuted}
          />
        ))}
        {stage.length === 0 && (
          <li className="px-3 py-4 text-[12.5px] text-ink-3">
            Nobody is presenting yet.
          </li>
        )}
      </Group>

      {/* An attendee gets no Attendees section at all — not a count, not a list,
          not even the "audience is private" notice. That headcount and roster
          are for whoever is running or presenting the session; an ordinary
          attendee clicking Participants is checking who is on stage, not
          sizing up the room. Panelists keep exactly what they had. */}
      {join.role !== "attendee" &&
        (controls.hideAttendees ? (
          <div className="border-t border-line px-3 py-4">
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
              <EyeOffIcon className="size-3.5 text-ink-3" />
              The audience is private
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
              The host has hidden attendees. You can still see the panelists —
              including yourself — but not the rest of the audience.
            </p>
          </div>
        ) : (
          <Group title="Attendees" count={audience.length}>
            {audience.map((p) => (
              <AudienceRow
                key={p.identity}
                name={p.name || p.identity}
                identity={p.identity}
                role="attendee"
                isMe={p.identity === join.identity || p.isLocal}
                muted
              />
            ))}
            {audience.length === 0 && (
              <li className="px-3 py-4 text-[12.5px] text-ink-3">
                {room.state === "connected"
                  ? "You're the first one here."
                  : "Connecting…"}
              </li>
            )}
          </Group>
        ))}
      </div>
    </div>
  );
}

/** The host header's headcount: a number for the stage and one for the
 *  audience, with the stage's faces when the row is wide enough to keep both
 *  labels whole. The counts are the server's, so they include anybody the room
 *  is hiding; the faces are capped at three and are only ever the stage. */
function RosterStats({
  onStage,
  attending,
  faces,
}: {
  onStage: number;
  attending: number;
  faces: { name: string; identity: string }[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
      <span className="flex min-w-0 items-center gap-1.5">
        {faces.length > 0 && (
          <span className="hidden shrink-0 -space-x-1.5 @[22rem]:flex">
            {faces.map((f) => (
              <SenderAvatar
                key={f.identity}
                name={f.name}
                identity={f.identity}
                size="xs"
                className="ring-2 ring-surface"
              />
            ))}
          </span>
        )}
        <span className="truncate text-[12px] text-ink-3">
          <span className="font-semibold text-ink tabular-nums">{onStage}</span> on stage
        </span>
      </span>
      <span aria-hidden className="h-3.5 w-px shrink-0 bg-line-2" />
      <span className="flex min-w-0 items-center gap-1.5">
        <UsersIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate text-[12px] text-ink-3">
          <span className="font-semibold text-ink tabular-nums">{attending}</span> attending
        </span>
      </span>
    </div>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line bg-surface/95 px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase backdrop-blur">
        {title}
        <span className="rounded-full bg-surface-2 px-1.5 text-[10px] leading-4 tracking-normal text-ink-2 tabular-nums">
          {count}
        </span>
      </p>
      <ul className="divide-y divide-line">{children}</ul>
    </div>
  );
}

function AudienceRow({
  name,
  identity,
  role,
  isMe,
  muted,
}: {
  name: string;
  identity: string;
  role: Role;
  isMe: boolean;
  muted: boolean;
}) {
  return (
    <li className={`flex items-center gap-2.5 px-3 py-2.5 ${isMe ? "bg-brand/[0.05]" : ""}`}>
      <SenderAvatar name={name} identity={identity} ring={role !== "attendee"} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-[13px] text-ink">{name}</span>
        {isMe && <span className="shrink-0 text-[11px] text-ink-3">(You)</span>}
        <RoleBadge role={role} />
      </span>
      {role !== "attendee" &&
        (muted ? (
          <MicOffIcon className="size-4 shrink-0 text-ink-3" aria-label="Muted" />
        ) : (
          <MicIcon className="size-4 shrink-0 text-ok" aria-label="Unmuted" />
        ))}
    </li>
  );
}

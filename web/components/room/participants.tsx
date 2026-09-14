"use client";

import {
  useLocalParticipant,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { LiveParticipant, LiveRoom, Role } from "@/lib/api-types";
import {
  matchRosterQuery,
  partitionHostRoster,
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
} from "../icons";
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

/** How often the host's roster is refreshed.
 *
 *  Polling rather than a socket: this is one request per host, not per attendee,
 *  and it is the only way to see hidden participants at all. Five seconds is
 *  responsive enough to moderate with and cheap enough to leave running. */
const ROSTER_POLL_MS = 5000;

export function useHostRoster(slug: string, enabled: boolean) {
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
    // A promise chain rather than a call to `load`, so the first read does not
    // set state synchronously inside the effect.
    const read = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      api
        .participants(slug)
        .then((room) => {
          if (!active) return;
          setLive(room);
          setError(false);
        })
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          inFlight.current = false;
        });
    };

    read();
    const timer = setInterval(read, ROSTER_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, slug]);

  // Memoised because this value goes into the room context. A fresh object every
  // render would bust that memo and re-render every panel, the stage and the control
  // bar on each of them — the exact cost the context was arranged to avoid.
  return useMemo(() => ({ live, error, reload: load }), [live, error, load]);
}

export function ParticipantsPanel() {
  const { isHost } = useRoomUI();
  return isHost ? <HostRoster /> : <AudienceRoster />;
}

// ---------------------------------------------------------------- host view

function HostRoster() {
  const { slug, join, realtime, controls, roster } = useRoomUI();
  const { localParticipant } = useLocalParticipant();
  const { notify } = useToast();
  // From the context rather than a poll of its own: the control bar needs the same
  // headcount for its badge whether or not this panel is open, and two five-second
  // polls of the same endpoint is one too many.
  const { live, error, reload } = roster;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const handIdentities = useMemo(
    () => new Set(realtime.hands.map((h) => h.identity)),
    [realtime.hands],
  );

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

  const sections = useMemo(
    () => partitionHostRoster(matching, realtime.hands),
    [matching, realtime.hands],
  );

  const showSearch = shouldShowRosterSearch(live?.participants.length ?? 0, query);

  const empty =
    sections.raised.length + sections.panelists.length + sections.attendees.length === 0;

  // The counts, the search box and the privacy chip render straight away and only
  // the list waits. Replacing the whole panel with a spinner meant every open —
  // and every one of the five-second refreshes — flashed the chrome away.
  const loading = !live && !error;

  const row = (p: LiveParticipant) => (
    <HostRosterRow
      key={p.identity}
      participant={p}
      isMe={p.identity === join.identity}
      handRaised={handIdentities.has(p.identity)}
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
              ? `${p.name} can speak now`
              : `${p.name} is on the stage`,
          async () => {
            await api.setStage(slug, p.identity, role, audioOnly);
            // Their request has been answered either way, so it comes
            // out of the queue — on every client, including theirs.
            if (handIdentities.has(p.identity)) {
              await realtime.lowerHand(
                p.identity,
                role === "panelist" ? "granted" : "dismissed",
              );
            }
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
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <span className="font-medium text-ink">{live?.onStage ?? 0} on stage</span>
          <span className="text-ink-3">·</span>
          <span>{live?.attendees ?? 0} attending</span>
          {controls.hideAttendees && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2"
              title="Attendees cannot see each other. You can, because this list comes from the server."
            >
              <EyeOffIcon className="size-3" />
              Hidden
            </span>
          )}
        </div>

        {/* The queue, and the one action that clears it.
            
            Shown here rather than only per-row because a host who has finished taking
            questions wants to move on, not to dismiss eleven people one at a time.
            Each row still has its own "Dismiss request" for passing over one person. */}
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
              Lower all
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
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-line px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-8"
        >
          {busy === "mute-all" ? (
            <Spinner className="size-3.5" />
          ) : (
            <MicOffIcon className="size-3.5" />
          )}
          Mute everyone except you
        </button>

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
              <Group title={`Raised hands · ${sections.raised.length}`}>
                {sections.raised.map(row)}
              </Group>
            )}
            <Group title={`Panelists · ${sections.panelists.length}`}>
              {sections.panelists.length === 0 ? (
                <li className="px-3 py-4 text-[12.5px] text-ink-3">
                  Nobody on the stage.
                </li>
              ) : (
                sections.panelists.map(row)
              )}
            </Group>
            <Group title={`Attendees · ${sections.attendees.length}`}>
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

  return (
    <li className="flex min-h-12 items-center gap-2.5 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">
            {p.name || p.identity}
          </span>
          {isMe && <span className="text-[11px] text-ink-3">(Me)</span>}
          {handRaised && (
            <HandIcon className="size-3.5 shrink-0 text-warn" aria-label="Hand raised" />
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
          {isHost
            ? "Host"
            : p.coHost
              ? "Co-host"
              : p.role === "panelist"
                ? speakingOnly
                  ? "Allowed to speak"
                  : "Panelist"
                : "Attendee"}
          {sharing && <span className="text-brand">· sharing screen</span>}
          {silenced && <span className="text-warn">· muted by you</span>}
          {canSpeak && hasMic && !p.audioMuted && <span className="text-ok">· live</span>}
          {canSpeak && !hasMic && <span>· hasn&apos;t unmuted</span>}
        </span>
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
                    {
                      kind: "action" as const,
                      label: "Allow to speak",
                      hint: "mic and screen share",
                      icon: <MicIcon className="size-4" />,
                      onSelect: () => onStage("panelist", true),
                    },
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
              // have already been passed over in.
              ...(handRaised
                ? [
                    {
                      kind: "action" as const,
                      label: "Dismiss request",
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
              // Full parity with the host, for this one webinar. Offered on any
              // panelist row rather than only a confirmed scheduled one, because
              // the roster here cannot tell a scheduled panelist apart from a
              // promoted attendee — the server can, and refuses the rare
              // mis-click with a clear "only a panelist can be made co-host"
              // rather than a silent no-op.
              ...(onStageNow
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
      <Group title={`Panelists · ${stage.length}`}>
        {stage.map((p) => (
          <AudienceRow
            key={p.identity}
            name={p.name || p.identity}
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

      {controls.hideAttendees && join.role !== "attendee" ? (
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
        <Group title={`Attendees · ${audience.length}`}>
          {audience.map((p) => (
            <AudienceRow
              key={p.identity}
              name={p.name || p.identity}
              role="attendee"
              isMe={p.identity === join.identity || p.isLocal}
              muted
            />
          ))}
          {controls.hideAttendees && (
            <li className="px-3 py-2 text-[12px] leading-relaxed text-ink-3">
              Other attendees are hidden. You can still see yourself.
            </li>
          )}
          {audience.length === 0 && !controls.hideAttendees && (
            <li className="px-3 py-4 text-[12.5px] text-ink-3">
              {room.state === "connected"
                ? "You're the first one here."
                : "Connecting…"}
            </li>
          )}
        </Group>
      )}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="sticky top-0 z-10 border-b border-line bg-surface/95 px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase backdrop-blur">
        {title}
      </p>
      <ul className="divide-y divide-line">{children}</ul>
    </div>
  );
}

function AudienceRow({
  name,
  role,
  isMe,
  muted,
}: {
  name: string;
  role: Role;
  isMe: boolean;
  muted: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-ink">{name}</span>
          {isMe && <span className="text-[11px] text-ink-3">(Me)</span>}
        </span>
        {role !== "attendee" && (
          <span className="text-[11.5px] text-ink-3">
            {role === "host" ? "Host" : "Panelist"}
          </span>
        )}
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

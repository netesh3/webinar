"use client";

import { useParticipants } from "@livekit/components-react";
import { useMemo } from "react";
import type { MentionCandidate } from "@/lib/mentions";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

/* Who this client knows about, for the mention picker and for naming tags in messages.
 *
 * Only what this client is already allowed to see, in order of authority:
 *
 *   the host's roster   the server's list, hidden attendees included — the host and
 *                       co-hosts only (`roster.live` is null for everyone else).
 *   LiveKit             this connection's participants. The SFU withholds hidden
 *                       attendees from everyone but the stage, so nothing here can
 *                       reveal them. In the CDN attendee room the connection is
 *                       data-only, and this may be just the stage.
 *   chat senders        people who have spoken, with the role the server stamped on
 *                       their message. Useful where the lists above are thin — the
 *                       CDN room — and never a leak: the message already said who.
 *
 * The picker then applies canMention on top, so e.g. an attendee who spoke publicly
 * is still not offered to another attendee while the host hides the audience. The
 * server re-checks everything and drops what it disagrees with.
 */
export function useMentionPeople(): {
  people: MentionCandidate[];
  nameFor: (identity: string) => string | undefined;
} {
  const { roster, realtime, me, join } = useRoomUI();
  const participants = useParticipants();

  return useMemo(() => {
    const people: MentionCandidate[] = [];
    for (const p of roster.live?.participants ?? []) {
      people.push({ identity: p.identity, name: p.name || p.identity, role: p.role, coHost: p.coHost });
    }
    const self = { identity: join.identity, role: me.role };
    for (const p of participants) {
      let coHost = false;
      try {
        coHost = p.metadata ? (JSON.parse(p.metadata) as { coHost?: unknown }).coHost === true : false;
      } catch {
        // Metadata we did not write.
      }
      people.push({
        identity: p.identity,
        name: p.name || p.identity,
        role: participantRole(p, self),
        coHost,
      });
    }
    for (let i = realtime.chat.length - 1; i >= 0; i--) {
      const from = realtime.chat[i].from;
      people.push({ identity: from.identity, name: from.name, role: from.role });
    }

    const names = new Map<string, string>([[me.identity, me.name]]);
    for (const p of people) if (!names.has(p.identity)) names.set(p.identity, p.name);
    return { people, nameFor: (identity: string) => names.get(identity) };
  }, [roster.live, participants, realtime.chat, me.identity, me.name, me.role, join.identity]);
}

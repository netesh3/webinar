"use client";

import { createContext, useContext } from "react";
import type { JoinResponse, LiveRoom, Poll, SessionControls } from "@/lib/api-types";
import type { MediaPreferences } from "@/lib/media";
import type { LocalVideoTrack } from "livekit-client";
import type { NetworkHealth } from "@/lib/network";
import type { MediaPermissions } from "@/lib/permissions";
import type { FileShareApi } from "@/lib/file-share";
import type { StageLayoutApi } from "@/lib/layout";
import type { Realtime, Sender } from "@/lib/realtime";
import type { ToolApi, ToolId } from "@/lib/tools";

/* Shared state for the room UI.
 *
 * A context rather than props because the stage, the control bar, four panels
 * and the host's moderation sheet all need the same handful of values, and
 * threading them through six levels makes every signature noise.
 *
 * Deliberately NOT in here: anything derived from LiveKit. Participants, tracks
 * and connection state come from the LiveKit hooks at the point of use, so a
 * speaker change re-renders one tile instead of the whole room.
 */

/** Kept as an alias so nothing has to care that the panels became windows. The
 *  set of ids is the same one the tool registry defines — a second list here is
 *  how the old side panel and the old control bar drifted apart. */
export type PanelId = ToolId;

export type RoomUI = {
  slug: string;
  join: JoinResponse;
  /** The credential an attendee joined with, for the endpoints that take one — the
   *  realtime relay and voting in a poll. Undefined for the host and the panelists,
   *  who are authorized by their session, and for an attendee who joined on theirs. */
  joinKey?: string;
  /** The live session controls: from room metadata once connected, from the join
   *  response until then. */
  controls: SessionControls;
  /** Topic from room metadata when available, so a rename reaches everyone. */
  topic: string;
  /** The webinar's own cover image, from the schedule form — see
   *  stage.tsx's WaitingForStage, which shows it to an attendee before the
   *  host has published anything. Null when the host never uploaded one, or
   *  for the host/panelist's own session, which never reaches that screen. */
  coverImageUrl: string | null;
  /** When the host took the session live (RFC3339). From room metadata once
   *  connected, otherwise the join response. The header clock counts from this
   *  — not from this browser's connect time — so a late joiner matches everyone. */
  startedAt: string | null;
  /** When the host ended the session (RFC3339). Freezes the elapsed clock. */
  endedAt: string | null;
  /** Live status from room metadata when available (scheduled | live | ended). */
  status: string | null;
  /** Whether the session is being recorded, as announced by the server. Everyone
   *  in the room sees this, which is the whole point: being recorded without being
   *  told is not something to leave to the client that pressed the button. */
  recording: boolean;

  isHost: boolean;
  /** Live publish permissions, from the connection rather than the join response.
   *  The host can grant or revoke these mid-session, and reading them from the
   *  join response is why "allow this attendee to speak" appeared to do nothing. */
  permissions: MediaPermissions;
  me: Sender;

  /* The camera captured on the pre-join screen, before the room exists.
   *
   * Kept in context because the stage needs it during the seconds it takes to connect. A
   * presenter who has just turned their camera on and pressed Join was shown a pulsing dot
   * on a black stage until the connection completed and the track published — so the one
   * question they had, "is my camera working", went unanswered exactly when they were
   * checking. The published track takes over the moment it arrives; this is only for the
   * gap before it. Null for the audience, who capture nothing. */
  entryVideo: LocalVideoTrack | null;

  /** Which recovery attempt is in flight, or null when the connection is not being
   *  retried. The banner reads this so a retry says "Reconnecting" rather than the
   *  SDK's bare "Disconnected", which is what a dropped connection looks like from
   *  inside the gap between attempts. */
  recovering: number | null;

  realtime: Realtime;

  /* The room as the SERVER sees it, polled for the host only.
   *
   * It is the only source that includes hidden attendees — the SFU deliberately does
   * not tell any client about them, including the host's — so it is the only honest
   * headcount and the only list a host can moderate from. `live` is null for anyone
   * who is not the host, and until the first response lands. */
  roster: {
    live: LiveRoom | null;
    error: boolean;
    reload: () => Promise<void>;
  };

  /* The polls this participant is entitled to see, for everyone who is NOT the host.
   *
   * Room-level rather than panel-level because a launched poll has to appear whether
   * or not the panel is open — that is the whole point of the pop-up. Re-read when the
   * server announces a change, so nothing polls: see PollsChangedMessage.
   *
   * Null for the host, whose own panel reads the fuller host endpoint. */
  polls: {
    list: Poll[] | null;
    reload: () => void;
    /** Replaces one poll in place, after voting. */
    replace: (poll: Poll) => void;
  };

  /** What getStats says about this connection, and which rung of the publish ladder is
   *  in use. Sampled every two seconds — see lib/network.ts. */
  network: NetworkHealth;

  /* The tool layout: bar pins, More grid, docked engagement panel, and floating
   * windows for Host / Settings / Invite. Owned by useToolLayout. */
  tools: ToolApi;
  /** Which tools this person may use, from their role and the live controls.
   *  Recomputed rather than captured at join: a host turning polls on, or
   *  promoting somebody, changes it mid-session. */
  availableTools: ToolId[];
  /** Unread counts for the tools that are not currently in front of you. */
  unread: Record<ToolId, number>;

  /* Sharing a recorded video as the presenter's screen.
   *
   * In the room context rather than local to the control bar because three
   * unrelated places need it: the picker starts it, the playback bar drives it,
   * and the tile has to know that the local screen share is safe to render — a
   * captured file cannot mirror itself the way a captured desktop can. */
  fileShare: FileShareApi;

  /* How THIS viewer wants the stage laid out, and what that means for bandwidth.
   *
   * Entirely client-side: nothing here is published, and no other participant can
   * observe it. That is the requirement, not a shortcut — a viewer switching to a
   * grid must not reframe the session for everyone reading the slides. It also
   * decides which video tracks this browser subscribes to, which is why the pin
   * and the page live here rather than inside the stage. */
  stage: StageLayoutApi;

  prefs: MediaPreferences;
  updatePrefs: (patch: Partial<MediaPreferences>) => void;

  leave: () => void;

  /** Dev chrome preview (`/preview/room`): no LiveKit media. Share and similar
   *  publish actions are mocked so the control bar still shows host affordances. */
  previewChrome?: boolean;
};

const RoomUIContext = createContext<RoomUI | null>(null);

export const RoomUIProvider = RoomUIContext.Provider;

export function useRoomUI(): RoomUI {
  const value = useContext(RoomUIContext);
  if (!value) {
    throw new Error("useRoomUI must be used inside the webinar room");
  }
  return value;
}

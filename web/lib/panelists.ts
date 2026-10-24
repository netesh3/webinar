/* The panel, as the schedule form saves it and the room's menus offer it.
 *
 * Pure functions, so lib/panelists.test.mts can hold them to what the server does:
 * WebinarInput.PanelistEmails (omitted keeps the panel, an empty list clears it),
 * handleSetStage (a scheduled panelist's seat comes from the panel, not from a grant), and
 * requireTrueOwner (what a co-host may not do). */

/** The addresses typed in the "Panelist emails" box: commas, semicolons or new lines. */
export function parsePanelistEmails(box: string): string[] {
  return box
    .split(/[\n,;]/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** The box's starting text on the edit form: the panel as it is saved. */
export function panelistBox(saved: readonly string[] | undefined): string {
  return (saved ?? []).join(", ");
}

export type PanelistSave = {
  /** What to send as `panelistEmails`. Undefined means leave it out, so the panel is kept. */
  emails?: string[];
  /** Saved panelists this save would take off the stage, for the host to confirm. */
  removed: string[];
};

/**
 * What a save sends for the panel.
 *
 * On a create it is whatever is in the box. On an edit, a box the host never touched is
 * left out of the request, and the server keeps the panel exactly as it is — so editing the
 * title cannot take every panelist off the stage, and a panelist whose account has no address
 * to show in the box is not lost either. A box the host changed is the whole new panel, and
 * anybody it drops is listed in `removed` so the form can ask before it saves.
 */
export function panelistSave({
  editing,
  saved,
  box,
}: {
  editing: boolean;
  /** The saved panel's addresses (Webinar.panelistEmails, host views). */
  saved: readonly string[] | undefined;
  /** The box as it is now. */
  box: string;
}): PanelistSave {
  const emails = parsePanelistEmails(box);
  if (!editing) return { emails, removed: [] };
  const before = parsePanelistEmails(panelistBox(saved));
  const same =
    emails.length === before.length &&
    emails.every((e, i) => e.toLowerCase() === before[i].toLowerCase());
  if (same) return { removed: [] };
  const kept = new Set(emails.map((e) => e.toLowerCase()));
  return { emails, removed: before.filter((e) => !kept.has(e.toLowerCase())) };
}

/** The confirmation the form shows before a save takes panelists off the stage. */
export function removedPanelistsPrompt(removed: readonly string[]): string {
  if (removed.length === 1) {
    return `Saving takes ${removed[0]} off the stage, and their stage link stops working.`;
  }
  return `Saving takes ${removed.length} panelists off the stage (${removed.join(", ")}), and their stage links stop working.`;
}

/**
 * A scheduled panelist: somebody on the webinar's panel, joined with their account
 * ("user_" identity, hostIdentity on the API side). The host and co-hosts are too.
 * An attendee brought up on stage keeps their attendee identity ("att_").
 */
export function isScheduledPanelist(identity: string): boolean {
  return identity.startsWith("user_");
}

/**
 * The stage actions a host's roster offers on one row.
 *
 * "Audio only", "Also allow video" and "Remove speaker permission" change a grant that the
 * host made in the room, so they are only for an attendee brought on stage. A scheduled
 * panelist's seat comes from the panel itself (handleSetStage refuses a "user_" identity),
 * and offering them there only ever produced an error: the host mutes a panelist instead,
 * or takes them off the panel in Setup.
 */
export function stageActions(p: {
  identity: string;
  role: string;
  audioOnly: boolean;
  /** Is this row the host? */
  isHost: boolean;
  /** No stage to move on or off: a meeting, or a simulive while it plays. */
  stageless: boolean;
}): { audioOnly: boolean; alsoVideo: boolean; removeSpeaker: boolean } {
  const promoted =
    p.role === "panelist" && !p.isHost && !p.stageless && !isScheduledPanelist(p.identity);
  return {
    audioOnly: promoted && !p.audioOnly,
    alsoVideo: promoted && p.audioOnly,
    removeSpeaker: promoted,
  };
}

/** One line of a Leave menu, in order. "handover" is "Make <name> the host and leave". */
export type LeaveMenuItem =
  | { kind: "handover"; identity: string; name: string }
  | { kind: "leave" }
  | { kind: "end" };

/**
 * What the Leave menu offers somebody who runs the room (api host_transfer.go).
 *
 * The host, with co-hosts in the room: "Make <co-host> the host and leave", one line per
 * co-host, and "End for everyone". No plain Leave: a host with somebody to hand over to
 * hands over, so the room is never left with co-hosts and no host by accident.
 *
 * The host with no co-host in the room: a plain Leave and "End for everyone". A webinar's
 * stage carries on without them, as when their tab closes; a meeting carries on too, but
 * nobody can be let in from the lobby. The menu says that making somebody co-host first is
 * what lets them hand over (HOST_LEAVE_NO_COHOST_NOTE).
 *
 * A co-host: a plain Leave (the session carries on with the host) and End. Handing over is
 * the host's alone (requireTrueOwner on /transfer-host).
 */
export function leaveMenuItems(
  owner: boolean,
  coHosts: readonly { identity: string; name?: string }[] = [],
): LeaveMenuItem[] {
  if (owner && coHosts.length > 0) {
    return [
      ...coHosts.map((c) => ({
        kind: "handover" as const,
        identity: c.identity,
        name: c.name?.trim() || "Co-host",
      })),
      { kind: "end" },
    ];
  }
  return [{ kind: "leave" }, { kind: "end" }];
}

/** The label of a hand-over line in the host's Leave menu. */
export function handoverLabel(name: string): string {
  return `Make ${name.trim() || "Co-host"} the host and leave`;
}

/** Under the host's plain Leave, when there is nobody to hand over to. */
export const HOST_LEAVE_NO_COHOST_NOTE =
  "To hand over instead, make someone a co-host first (Participants → Make co-host).";

/**
 * Whether a roster row offers "Make co-host" / "Remove co-host".
 *
 * Only to the host (`viewerIsOwner`): a co-host cannot make or unmake a co-host
 * (requireTrueOwner on both co-host routes). Then anybody on the stage but the host: an
 * invited panelist ("user_"), and an attendee brought up on stage or a meeting guest ("att_").
 * The server decides the rest by the account behind the identity (handleSetParticipantCoHost)
 * — an "att_" with no account answers cohost_needs_account, which the roster explains with
 * coHostNeedsAccountMessage. Never anybody in the audience, and never an identity that is
 * neither (an egress, a recorder).
 */
export function canMakeCoHost(
  p: { identity: string; role: string; isHost: boolean },
  viewerIsOwner: boolean,
): boolean {
  if (!viewerIsOwner) return false;
  if (p.role !== "panelist" || p.isHost) return false;
  return /^(user|att)_./.test(p.identity);
}

/** The error code the server answers when an attendee has no account to be co-host with. */
export const COHOST_NEEDS_ACCOUNT = "cohost_needs_account";

/** The toast when somebody cannot be made co-host until they sign in. */
export function coHostNeedsAccountMessage(name: string): string {
  return `${name.trim() || "This person"} needs to sign in to be a co-host — ask them to sign in with the same email and rejoin.`;
}

/** The hint on "Make co-host" in the roster. */
export const CO_HOST_HINT = "runs the room with you";

/** The note once somebody is made co-host: what they can do, and what stays with the owner. */
export function coHostGrantedMessage(name: string, meeting: boolean): string {
  const what = meeting ? "meeting" : "webinar";
  return (
    `${name} is now a co-host for this session. They can mute, manage the ${meeting ? "lobby" : "stage"}, run polls and Q&A, ` +
    `remove people and end the ${what}. Making co-hosts, deleting or copying the ${what}, handing over the host role, ` +
    `sending follow-ups and deleting recordings stay with you. When you leave, you can make them the host.`
  );
}

import type { ChatDestination } from "./realtime";

/* Who attendees may chat with — the host's one choice at the top of the Chat panel.
 *
 * The server stores this as two fields: `chatEnabled`, and `chatDestination` for
 * where an attendee's message goes while it is on. The host sees one three-way
 * choice. Turning chat off writes only `chatEnabled`, so the destination survives
 * and switching back on returns to whatever it was — see chatPermissionPatch.
 */

export type ChatPermission = ChatDestination | "off";

export const CHAT_PERMISSIONS: readonly ChatPermission[] = ["everyone", "panelists", "off"];

export type ChatPermissionCopy = {
  /** The segment's label. Short, because three sit in a 360px panel. */
  label: string;
  /** The collapsed summary: "Attendee chat: <summary>". */
  summary: string;
  /** One line, in plain words, saying what the setting does right now. */
  effect: string;
};

// "Panelists" is the word the rest of the room uses — the To picker, the
// "Panelists only" badge on a message — so the host's control uses it too.
const COPY: Record<ChatPermission, ChatPermissionCopy> = {
  everyone: {
    label: "Everyone",
    summary: "Everyone",
    effect: "Attendees can message everyone in the webinar.",
  },
  panelists: {
    label: "Panelists",
    summary: "Panelists only",
    effect: "Attendees can only message you and the panelists.",
  },
  off: {
    label: "Off",
    summary: "Off",
    effect: "Chat is off for attendees. You and panelists can still chat.",
  },
};

export function chatPermissionCopy(p: ChatPermission): ChatPermissionCopy {
  return COPY[p];
}

/** The room's two fields, as the one choice the host sees. */
export function chatPermissionOf(controls: {
  chatEnabled: boolean;
  chatDestination: string;
}): ChatPermission {
  if (!controls.chatEnabled) return "off";
  return controls.chatDestination === "panelists" ? "panelists" : "everyone";
}

/** What to send the API for a choice. "off" leaves the destination alone. */
export function chatPermissionPatch(
  p: ChatPermission,
): { chatEnabled: false } | { chatEnabled: true; chatDestination: ChatDestination } {
  return p === "off" ? { chatEnabled: false } : { chatEnabled: true, chatDestination: p };
}

/** Radiogroup arrow-key movement: wraps at both ends, Home and End jump. Null for
 *  any other key, so the caller leaves it to the browser. */
export function chatPermissionStep(current: ChatPermission, key: string): ChatPermission | null {
  const i = CHAT_PERMISSIONS.indexOf(current);
  const n = CHAT_PERMISSIONS.length;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return CHAT_PERMISSIONS[(i + 1) % n];
    case "ArrowLeft":
    case "ArrowUp":
      return CHAT_PERMISSIONS[(i - 1 + n) % n];
    case "Home":
      return CHAT_PERMISSIONS[0];
    case "End":
      return CHAT_PERMISSIONS[n - 1];
    default:
      return null;
  }
}

/** localStorage value for whether the host's attendee-chat switcher is open. */
export const CHAT_PERMISSION_OPEN_KEY = "room.chatPermission.open";

/** Whether that switcher starts open.
 *
 * Nothing saved means open, so Everyone, Panelists, and Off are visible the
 * first time a host opens Chat. A stored "0" is a collapse this browser already
 * chose, and that stays closed.
 */
export function chatPermissionStartsOpen(stored: string | null): boolean {
  return stored !== "0";
}

/** What to write when the host toggles the switcher.
 *
 * With no saved "0" or "1", return null so a collapse is not stored and the next
 * webinar still starts open. An existing preference is updated, including a
 * collapse the host already saved.
 */
export function chatPermissionOpenStored(
  open: boolean,
  stored: string | null,
): "0" | "1" | null {
  if (stored !== "0" && stored !== "1") return null;
  return open ? "1" : "0";
}

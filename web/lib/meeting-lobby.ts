/* What a meeting guest's screen says while they are at the door.
 *
 * A meeting's way in is a name and a wait (api/internal/api/meeting.go): the guest knocks
 * (POST /meeting/knock), keeps the join key it answers with, and polls the ordinary POST /join
 * with it until the host decides. Every answer the server can give on that path has its own
 * code, and each one is a different screen — still waiting (keep polling), turned away (stop,
 * and do not offer to ask again: the same browser asking a second later is the same person),
 * full, ended, locked. This file is that mapping and nothing else, so node can test it and the
 * two places that show it (the landing page's door and the room gate) cannot drift apart.
 *
 * Pure: no React, no fetch. The components own the polling; this only says whether to.
 */

/** How often the waiting screen asks POST /join whether the host has let them in. The host's
 *  lobby list polls on its own clock; three seconds is a wait nobody notices on admission and
 *  a load the join limiter does not either, for a room of at most fifty. */
export const MEETING_POLL_MS = 3_000;

export type LobbyPhase =
  /** Show the name field: no key yet, or one the server does not know. */
  | "knock"
  /** In the queue. Poll. */
  | "waiting"
  /** The host said no. Terminal for this key. */
  | "denied"
  /** At the cap. Somebody leaving frees a seat, so a retry can work. */
  | "full"
  /** Over. Terminal. */
  | "ended"
  /** The host locked the door. A retry can work once they unlock it. */
  | "locked"
  /** Too many waiting at once. A retry in a moment can work. */
  | "busy"
  /** The host removed them. Asking again is a new request the host can answer. */
  | "removed"
  /** Anything else: the server's sentence, and a retry. */
  | "error";

export type LobbyScreen = {
  phase: LobbyPhase;
  title: string;
  /** Empty when the title says it all. */
  body: string;
  /** Ask POST /join again on MEETING_POLL_MS, without a click. */
  poll: boolean;
  /** Offer "Try again". */
  retry: boolean;
  /** Offer the name field again, for a fresh knock without the old key. */
  knockAgain: boolean;
};

export const WAITING_TITLE = "Waiting for the host to let you in…";
export const WAITING_BODY =
  "The host knows you're here. Keep this page open — you'll go in as soon as they admit you.";
export const DENIED_TITLE = "The host didn't let you in";
export const ENDED_TITLE = "This meeting has ended";

/* The codes that mean "this browser holds nothing the server will take", so the answer is the
 * name field rather than an error card: a signed-in account with no knock, a key from another
 * meeting, or a door (/register, /guest-join) that tells a meeting's guest to knock. */
const KNOCK_CODES = new Set([
  "not_registered",
  "registration_required",
  "no_join_key",
  "invalid_join_key",
  "meeting_knock",
  "not_found",
]);

function screen(
  phase: LobbyPhase,
  title: string,
  body: string,
  flags: Partial<Pick<LobbyScreen, "poll" | "retry" | "knockAgain">> = {},
): LobbyScreen {
  return {
    phase,
    title,
    body: body.trim() === title.trim() ? "" : body,
    poll: flags.poll ?? false,
    retry: flags.retry ?? false,
    knockAgain: flags.knockAgain ?? false,
  };
}

/** The screen for a refused knock or join, from the API's error code and its sentence. */
export function lobbyScreen(code: string, message: string): LobbyScreen {
  if (KNOCK_CODES.has(code)) return screen("knock", "Ask to join", "");
  switch (code) {
    case "waiting_for_host":
      return screen("waiting", WAITING_TITLE, WAITING_BODY, { poll: true });
    // The video server waking up, or the host not having opened the room yet: from the
    // guest's side both are still "wait", and the next poll finds out.
    case "sfu_starting":
    case "not_started":
      return screen("waiting", "Getting the meeting ready…", WAITING_BODY, { poll: true });
    case "lobby_denied":
      return screen(
        "denied",
        DENIED_TITLE,
        "You can't join this meeting. If you think that's a mistake, ask the host for a new invitation.",
      );
    case "meeting_full":
      return screen(
        "full",
        "This meeting is full",
        message || "Everyone it can hold is already in. Try again when somebody leaves.",
        { retry: true },
      );
    case "meeting_ended":
    case "ended":
    case "not_joinable":
      return screen("ended", ENDED_TITLE, "The host has ended this meeting.");
    case "locked":
      return screen(
        "locked",
        "The host has locked this meeting",
        "Nobody new can join right now. Try again in a little while.",
        { retry: true },
      );
    case "lobby_full":
      return screen(
        "busy",
        "Lots of people are waiting",
        message || "Too many people are waiting to join. Try again in a moment.",
        { retry: true },
      );
    case "removed":
      return screen(
        "removed",
        "You were removed from this meeting",
        "You can ask to join again, and the host will decide.",
        { knockAgain: true },
      );
    default:
      return screen("error", "Can't join yet", message || "Could not reach the meeting.", {
        retry: true,
      });
  }
}

/** What a successful knock means: either way the next step is POST /join with the key, which
 *  answers a waiting guest with waiting_for_host and an admitted one with a token. */
export function knockGoesIn(state: string): boolean {
  return state === "waiting" || state === "admitted";
}

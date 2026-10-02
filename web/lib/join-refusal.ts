/* What the attendee join screen says when POST /join refuses them.
 *
 * The title and the body used to be the same sentence: the API's "This webinar
 * isn't running." was also the heading, and Try again sat under a session that
 * was already over. Ended is terminal. Not started, and a network or server
 * failure, are not — those still offer another attempt.
 */

export type JoinRefusalAction = "retry" | "register" | "none";

export type JoinRefusal = {
  title: string;
  /** Empty when it would only repeat the title. */
  body: string;
  /** `none` is a finished session: another attempt cannot open it. */
  action: JoinRefusalAction;
};

export const ENDED_JOIN_TITLE = "This webinar has ended";
export const ENDED_JOIN_BODY =
  "Thanks for your interest. The host has ended this session.";

const REGISTER_CODES = new Set([
  "not_registered",
  "registration_required",
  "no_join_key",
  "invalid_join_key",
]);

/** `ended` is a finished session, including one the API lapsed to completed
 *  because it never went live. */
export function joinCodeIsEnded(code: string): boolean {
  return code === "ended";
}

/** Maps a join error code and the API's sentence onto the card. */
export function attendeeJoinRefusal(code: string, message: string): JoinRefusal {
  if (joinCodeIsEnded(code)) {
    return { title: ENDED_JOIN_TITLE, body: ENDED_JOIN_BODY, action: "none" };
  }
  const title = joinRefusalTitle(code);
  return {
    title,
    body: bodyUnlessRepeat(title, message),
    action: REGISTER_CODES.has(code) ? "register" : "retry",
  };
}

function joinRefusalTitle(code: string): string {
  switch (code) {
    case "not_approved":
      return "Waiting for approval";
    case "locked":
      return "The webinar is locked";
    case "room_full":
      return "The webinar is full";
    case "not_joinable":
      return "This webinar isn't running";
    case "not_started":
      return "This webinar hasn't started";
    case "zoom_link_missing":
      return "Your Zoom link isn't ready";
    case "not_registered":
    case "registration_required":
    case "no_join_key":
      return "You're not registered yet";
    case "invalid_join_key":
      return "This join link isn't valid";
    default:
      return "Can't join yet";
  }
}

/** Drop a body that is the title again, including a trailing period. */
function bodyUnlessRepeat(title: string, message: string): string {
  const body = message.trim();
  if (!body) return "";
  if (normalize(body) === normalize(title)) return "";
  return body;
}

function normalize(s: string): string {
  return s.trim().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}

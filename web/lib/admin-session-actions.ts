/* What an admin may do to one session on the Webinars tab, and what each confirm says.
 *
 * The server decides (api/internal/api/admin_sessions.go): End only when live, and not for
 * a Zoom venue; status only between draft and scheduled; Delete always. This mirrors it so
 * the row offers only buttons that will work. Pure, so it is checked without a browser —
 * see admin-session-actions.test.mts. */

export type AdminSessionKindFilter = "" | "webinar" | "meeting" | "simulive";

export const KIND_FILTERS: { value: AdminSessionKindFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "webinar", label: "Webinars" },
  { value: "meeting", label: "Meetings" },
  { value: "simulive", label: "Simulive" },
];

type SessionLike = {
  topic: string;
  kind: string;
  status: string;
  venue?: string;
};

export type AdminSessionAction = "end" | "publish" | "unpublish" | "delete";

function isZoom(venue?: string): boolean {
  return venue === "zoom_meeting" || venue === "zoom_webinar";
}

/** The actions a row offers, in the order they are shown. */
export function adminSessionActions(w: SessionLike): AdminSessionAction[] {
  const out: AdminSessionAction[] = [];
  if (w.status === "live" && !isZoom(w.venue)) out.push("end");
  if (w.status === "draft") out.push("publish");
  if (w.status === "scheduled") out.push("unpublish");
  out.push("delete");
  return out;
}

/** "meeting", "simulive" or "webinar", for the sentences below. */
export function sessionNoun(kind: string): string {
  if (kind === "meeting") return "meeting";
  if (kind === "simulive") return "simulive";
  return "webinar";
}

/** The confirm dialog's title, body and button for one action, in plain words. */
export function adminActionCopy(
  action: AdminSessionAction,
  w: SessionLike,
): { title: string; body: string; confirm: string } {
  const noun = sessionNoun(w.kind);
  switch (action) {
    case "end":
      return {
        title: `End "${w.topic}" now?`,
        body: `Everyone in this ${noun} is disconnected right away, the host included. Recordings stop and are saved, attendance and the report are finalised, and the recap and follow-ups go out as if the host had ended it. It can't be restarted.`,
        confirm: `End ${noun}`,
      };
    case "publish":
      return {
        title: `Publish "${w.topic}"?`,
        body: `This ${noun} becomes scheduled: its page is public again and people can register and join at the start time.`,
        confirm: "Publish",
      };
    case "unpublish":
      return {
        title: `Move "${w.topic}" back to draft?`,
        body: `Its public page stops showing it and nobody new can register or join until it is published again. People already registered keep their registration, but are not told about the change.`,
        confirm: "Move to draft",
      };
    case "delete":
      return {
        title: `Delete "${w.topic}"?`,
        body: `This permanently removes the ${noun} and every registration, chat message, poll, recording and question attached to it. If it's live right now, everyone is disconnected and the room is closed. A Zoom meeting it runs on is deleted too. This can't be undone.`,
        confirm: `Delete ${noun}`,
      };
  }
}

/** Delete is armed once the admin has typed the topic, or DELETE. Case and outer spaces
 *  don't matter; anything else does. */
export function deleteConfirmMatches(typed: string, topic: string): boolean {
  const t = typed.trim().toLowerCase();
  if (t === "") return false;
  return t === "delete" || t === topic.trim().toLowerCase();
}

/* What a host is told before an irreversible delete.
 *
 * Shared by the list and the manage screen, and pure, because it is the one screen in the
 * product where being vague is a real cost. Deleting now removes the registrations, the chat
 * transcript, the poll answers and the recordings — and for a session running right now it also
 * throws the audience out. A dialog that says "this cannot be undone" without saying what is
 * being undone is not a confirmation, it is a speed bump.
 *
 * Written per status because the honest sentence genuinely differs. A draft has nothing but
 * itself; an ended webinar is the only copy of who attended.
 */
import type { Webinar } from "./api-types";

/** The dialog's heading. Names the thing being deleted, so a mis-click on the wrong row is
 *  visible before the second click rather than after it. */
export function deleteTitle(w: Webinar): string {
  switch (w.status) {
    case "draft":
      return "Delete this draft?";
    case "live":
      return "Delete this webinar while it is live?";
    case "ended":
      return "Delete this webinar and its records?";
    default:
      return "Delete this webinar?";
  }
}

/**
 * The body. One sentence on what goes, one on what it costs, and no euphemism.
 *
 * The registrant count is included when there is one: "48 registrants lose access" is a
 * different decision from "nobody has registered yet", and it is the number a host is most
 * likely to have forgotten.
 */
export function deleteWarning(w: Webinar): string {
  const people =
    w.registrantCount > 0
      ? `${w.registrantCount.toLocaleString("en-GB")} ${
          w.registrantCount === 1 ? "registrant" : "registrants"
        } lose access, and their details are deleted. `
      : "";

  const everything =
    "Registrations, the chat transcript, questions, polls and their answers, and every " +
    "recording are permanently deleted.";

  switch (w.status) {
    case "draft":
      // A draft has no public page and no audience, so there is nothing to warn about
      // beyond the work itself.
      return `“${w.topic}” is removed, along with anything set up on it. This cannot be undone.`;
    case "live":
      return (
        `“${w.topic}” is running now. Everyone in the room is disconnected immediately. ` +
        `${people}${everything} This cannot be undone.`
      );
    case "ended":
      return (
        `“${w.topic}” has already run, so this is the only record of it. ` +
        `${everything} The attendance report goes with it. This cannot be undone.`
      );
    default:
      return `“${w.topic}” and its registration page are removed. ${people}${everything} This cannot be undone.`;
  }
}

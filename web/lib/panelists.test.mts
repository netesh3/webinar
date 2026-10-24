/* The panel as the schedule form saves it, and the panel actions the room offers.
 *
 * Run: node --experimental-strip-types --no-warnings lib/panelists.test.mts
 */

import assert from "node:assert/strict";
import {
  coHostGrantedMessage,
  isScheduledPanelist,
  leaveMenuItems,
  panelistBox,
  panelistSave,
  parsePanelistEmails,
  removedPanelistsPrompt,
  stageActions,
} from "./panelists.ts";

// The box splits on commas, semicolons and new lines.
assert.deepEqual(parsePanelistEmails(" a@x.dev, b@x.dev;\nc@x.dev ,, "), ["a@x.dev", "b@x.dev", "c@x.dev"]);
assert.deepEqual(parsePanelistEmails(""), []);

// The edit form starts with the saved panel in the box.
const saved = ["pam@x.dev", "pia@x.dev"];
assert.equal(panelistBox(saved), "pam@x.dev, pia@x.dev");
assert.equal(panelistBox(undefined), "");

// Create: whatever is in the box, even nothing.
assert.deepEqual(panelistSave({ editing: false, saved: undefined, box: "a@x.dev" }), {
  emails: ["a@x.dev"],
  removed: [],
});
assert.deepEqual(panelistSave({ editing: false, saved: undefined, box: "" }), { emails: [], removed: [] });

// Edit, box untouched: the panel is left out, so the server keeps it (the PR #705 bug was
// sending an empty list here and wiping the panel).
assert.deepEqual(panelistSave({ editing: true, saved, box: panelistBox(saved) }), { removed: [] });
// Re-spaced or re-cased is still untouched.
assert.deepEqual(panelistSave({ editing: true, saved, box: "PAM@x.dev,\npia@x.dev" }), { removed: [] });
// An older server that does not send the addresses, and nobody typed: left out too.
assert.deepEqual(panelistSave({ editing: true, saved: undefined, box: "" }), { removed: [] });

// Edit, one added: the whole panel is sent, nobody removed.
assert.deepEqual(panelistSave({ editing: true, saved, box: "pam@x.dev, pia@x.dev, new@x.dev" }), {
  emails: ["pam@x.dev", "pia@x.dev", "new@x.dev"],
  removed: [],
});
// Edit, one taken out: sent, and named for the confirmation.
assert.deepEqual(panelistSave({ editing: true, saved, box: "pia@x.dev" }), {
  emails: ["pia@x.dev"],
  removed: ["pam@x.dev"],
});
// Edit, box cleared: an explicit empty list, with everybody named.
assert.deepEqual(panelistSave({ editing: true, saved, box: "  " }), { emails: [], removed: saved });

assert.match(removedPanelistsPrompt(["pam@x.dev"]), /pam@x\.dev off the stage/);
assert.match(removedPanelistsPrompt(saved), /2 panelists off the stage \(pam@x\.dev, pia@x\.dev\)/);

// Scheduled panelists have account identities; attendees brought up do not.
assert.equal(isScheduledPanelist("user_123"), true);
assert.equal(isScheduledPanelist("att_abc"), false);

// "Audio only" and "Remove speaker permission" are for an attendee brought on stage, never a
// scheduled panelist (the server refuses those: their seat comes from the panel).
const scheduled = stageActions({ identity: "user_1", role: "panelist", audioOnly: false, isHost: false, stageless: false });
assert.deepEqual(scheduled, { audioOnly: false, alsoVideo: false, removeSpeaker: false });
const promoted = stageActions({ identity: "att_1", role: "panelist", audioOnly: false, isHost: false, stageless: false });
assert.deepEqual(promoted, { audioOnly: true, alsoVideo: false, removeSpeaker: true });
const speaker = stageActions({ identity: "att_1", role: "panelist", audioOnly: true, isHost: false, stageless: false });
assert.deepEqual(speaker, { audioOnly: false, alsoVideo: true, removeSpeaker: true });
// Nothing in a meeting, nor for an attendee or the host.
assert.deepEqual(
  stageActions({ identity: "att_1", role: "panelist", audioOnly: false, isHost: false, stageless: true }),
  { audioOnly: false, alsoVideo: false, removeSpeaker: false },
);
assert.deepEqual(
  stageActions({ identity: "att_1", role: "attendee", audioOnly: false, isHost: false, stageless: false }),
  { audioOnly: false, alsoVideo: false, removeSpeaker: false },
);
assert.deepEqual(
  stageActions({ identity: "user_9", role: "host", audioOnly: false, isHost: true, stageless: false }),
  { audioOnly: false, alsoVideo: false, removeSpeaker: false },
);

// The owner may hand over; a co-host gets a plain Leave instead (transfer is owner-only).
assert.deepEqual(leaveMenuItems(true), ["assign", "end"]);
assert.deepEqual(leaveMenuItems(false), ["leave", "end"]);

// The co-host note says what stays with the owner rather than "full control".
const note = coHostGrantedMessage("Ravi", false);
assert.doesNotMatch(note, /like you can|same as you|full control/);
assert.match(note, /handing over the host role/);
assert.match(note, /deleting recordings/);
assert.match(coHostGrantedMessage("Ravi", true), /lobby/);

console.log("panelists: ok");

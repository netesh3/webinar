/* The panel as the schedule form saves it, and the panel actions the room offers.
 *
 * Run: node --experimental-strip-types --no-warnings lib/panelists.test.mts
 */

import assert from "node:assert/strict";
import {
  canMakeCoHost,
  COHOST_NEEDS_ACCOUNT,
  coHostGrantedMessage,
  coHostNeedsAccountMessage,
  handoverLabel,
  HOST_LEAVE_NO_COHOST_NOTE,
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

// The host with co-hosts in the room: one hand-over line per co-host, then End. No plain Leave.
assert.deepEqual(
  leaveMenuItems(true, [
    { identity: "user_1", name: "Ravi" },
    { identity: "att_K", name: " " },
  ]),
  [
    { kind: "handover", identity: "user_1", name: "Ravi" },
    { kind: "handover", identity: "att_K", name: "Co-host" },
    { kind: "end" },
  ],
);
assert.equal(handoverLabel("Ravi"), "Make Ravi the host and leave");
// The host with nobody to hand over to: a plain Leave and End, with the way to hand over said.
assert.deepEqual(leaveMenuItems(true, []), [{ kind: "leave" }, { kind: "end" }]);
assert.deepEqual(leaveMenuItems(true), [{ kind: "leave" }, { kind: "end" }]);
assert.match(HOST_LEAVE_NO_COHOST_NOTE, /co-host first/);
// A co-host: Leave and End, never a hand-over, whoever else is a co-host.
assert.deepEqual(leaveMenuItems(false, [{ identity: "user_2", name: "Mira" }]), [{ kind: "leave" }, { kind: "end" }]);

// The co-host note says what stays with the owner rather than "full control".
const note = coHostGrantedMessage("Ravi", false);
assert.doesNotMatch(note, /like you can|same as you|full control/);
assert.match(note, /handing over the host role/);
assert.match(note, /deleting recordings/);
assert.match(coHostGrantedMessage("Ravi", true), /lobby/);

// "Make co-host" is for anybody on the stage but the host: an invited panelist, an attendee
// brought up, a meeting guest. The server decides whether an "att_" has the account for it.
assert.equal(canMakeCoHost({ identity: "user_1", role: "panelist", isHost: false }, true), true);
assert.equal(canMakeCoHost({ identity: "att_ABC", role: "panelist", isHost: false }, true), true);
// Never the host, nobody in the audience, and no identity that is not a person.
assert.equal(canMakeCoHost({ identity: "user_9", role: "host", isHost: true }, true), false);
assert.equal(canMakeCoHost({ identity: "user_9", role: "panelist", isHost: true }, true), false);
assert.equal(canMakeCoHost({ identity: "att_ABC", role: "attendee", isHost: false }, true), false);
assert.equal(canMakeCoHost({ identity: "EG_recorder", role: "panelist", isHost: false }, true), false);
assert.equal(canMakeCoHost({ identity: "att_", role: "panelist", isHost: false }, true), false);
// Only the host is offered it: a co-host sees neither "Make co-host" nor "Remove co-host".
assert.equal(canMakeCoHost({ identity: "user_1", role: "panelist", isHost: false }, false), false);
assert.equal(canMakeCoHost({ identity: "att_ABC", role: "panelist", isHost: false }, false), false);
assert.match(coHostGrantedMessage("Ravi", false), /Making co-hosts/);
assert.match(coHostGrantedMessage("Ravi", false), /make them the host/);

// The server's code for "no account behind this attendee", and what the host is told.
assert.equal(COHOST_NEEDS_ACCOUNT, "cohost_needs_account");
assert.equal(
  coHostNeedsAccountMessage("Asha"),
  "Asha needs to sign in to be a co-host — ask them to sign in with the same email and rejoin.",
);
assert.match(coHostNeedsAccountMessage(" "), /^This person needs to sign in/);

console.log("panelists: ok");

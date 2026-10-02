/* The stage's "has the host started?" signal.
 *
 * It used to be "someone published a camera or a screen share." A host already
 * in the room with the mic muted and the camera off then left attendees on
 * "Waiting for the host to start." Presence in the room is the signal. A
 * recording pause is not, and a scheduled session the host has not entered
 * still waits.
 *
 * Run: node --experimental-strip-types --no-warnings lib/stage-presence.test.mts
 */

import assert from "node:assert/strict";
import {
  CAMERA_OFF_LABEL,
  WAITING_FOR_HOST_LABEL,
  emptyStageLabel,
  stagePresence,
  type StageSeat,
} from "./stage-presence.ts";

const host: StageSeat = {
  identity: "host_1",
  role: "host",
  hasCamera: false,
  hasScreenShare: false,
};

const attendee: StageSeat = {
  identity: "att_1",
  role: "attendee",
  hasCamera: false,
  hasScreenShare: false,
};

/* Host is in the room, microphone muted, camera never published.
 * Muted is not a field here: a missing mic track must not change the answer. */
const present = stagePresence({
  seats: [host, attendee],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(present.kind, "camera-off");
assert.deepEqual(
  present.kind === "camera-off" ? present.identities : [],
  ["host_1"],
);
assert.equal(emptyStageLabel("camera-off"), CAMERA_OFF_LABEL);
assert.equal(emptyStageLabel("camera-off"), "Camera off");
assert.notEqual(emptyStageLabel("camera-off"), WAITING_FOR_HOST_LABEL);
assert.doesNotMatch(emptyStageLabel("camera-off"), /waiting for the host/i);

/* The same room with the recorder paused is the same answer. Pause is not an
 * input — a paused badge must not be read as "not started." */
const pausedRecording = stagePresence({
  seats: [host, attendee],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.deepEqual(pausedRecording, present);

/* A panelist who is hosting, camera off, counts. The audience is not waiting. */
const panelist = stagePresence({
  seats: [
    attendee,
    { identity: "pan_1", role: "panelist", hasCamera: false, hasScreenShare: false },
  ],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(panelist.kind, "camera-off");
assert.deepEqual(
  panelist.kind === "camera-off" ? panelist.identities : [],
  ["pan_1"],
);

/* Host absent, and the webinar is not live: nobody who can host is in the
 * room. Attendees who are already inside (doors open) still wait. A session
 * that has not opened never reaches this helper — join still refuses it. */
const notLive = stagePresence({
  seats: [attendee],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(notLive.kind, "holding");
assert.equal(emptyStageLabel("holding"), WAITING_FOR_HOST_LABEL);
assert.equal(emptyStageLabel("holding"), "Waiting for the host to start");

const emptyRoom = stagePresence({
  seats: [],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(emptyRoom.kind, "holding");

/* An egress recorder in an otherwise empty room is not a host. */
const recorder = stagePresence({
  seats: [
    { identity: "EG_recorder", role: "panelist", hasCamera: false, hasScreenShare: false },
  ],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(recorder.kind, "holding");

/* Camera already on, or a screen share, stays the published stage. No
 * camera-off placeholder is added on top. */
const cameraOn = stagePresence({
  seats: [{ ...host, hasCamera: true }, attendee],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(cameraOn.kind, "media");

const sharing = stagePresence({
  seats: [{ ...host, hasScreenShare: true }],
  viewerIdentity: attendee.identity,
  viewerCanPresent: false,
});
assert.equal(sharing.kind, "media");

/* The host's own view, camera off: do not invent their initials tile. That
 * would replace the connecting preview in the moment before a camera they
 * already enabled is published. */
const self = stagePresence({
  seats: [host],
  viewerIdentity: host.identity,
  viewerCanPresent: true,
});
assert.equal(self.kind, "holding");

/* A presenter still sees the other people who are in with the camera off. */
const peer = stagePresence({
  seats: [
    host,
    { identity: "pan_1", role: "panelist", hasCamera: false, hasScreenShare: false },
  ],
  viewerIdentity: host.identity,
  viewerCanPresent: true,
});
assert.equal(peer.kind, "camera-off");
assert.deepEqual(peer.kind === "camera-off" ? peer.identities : [], ["pan_1"]);

console.log("stage-presence: ok");

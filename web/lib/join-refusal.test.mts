/* The attendee join card: ended is final, not-started and real failures retry,
 * and the body never repeats the title.
 *
 * Run: node --experimental-strip-types --no-warnings lib/join-refusal.test.mts
 */

import assert from "node:assert/strict";
import {
  ENDED_JOIN_BODY,
  ENDED_JOIN_TITLE,
  attendeeJoinRefusal,
} from "./join-refusal.ts";

const ended = attendeeJoinRefusal(
  "ended",
  "This webinar isn't running.",
);
assert.equal(ended.title, ENDED_JOIN_TITLE);
assert.equal(ended.title, "This webinar has ended");
assert.equal(ended.body, ENDED_JOIN_BODY);
assert.notEqual(ended.body, ended.title);
assert.equal(ended.action, "none");

const endedOwnSentence = attendeeJoinRefusal("ended", "This webinar has ended.");
assert.equal(endedOwnSentence.body, ENDED_JOIN_BODY);
assert.equal(endedOwnSentence.action, "none");

const notStarted = attendeeJoinRefusal(
  "not_started",
  "The host hasn't started this session yet.",
);
assert.equal(notStarted.title, "This webinar hasn't started");
assert.equal(notStarted.body, "The host hasn't started this session yet.");
assert.equal(notStarted.action, "retry");

const tooEarly = attendeeJoinRefusal(
  "too_early",
  "This webinar hasn't opened yet. You can join from 3:00 PM.",
);
assert.equal(tooEarly.title, "Can't join yet");
assert.match(tooEarly.body, /hasn't opened yet/);
assert.equal(tooEarly.action, "retry");

const duplicated = attendeeJoinRefusal("not_joinable", "This webinar isn't running.");
assert.equal(duplicated.title, "This webinar isn't running");
assert.equal(duplicated.body, "");
assert.equal(duplicated.action, "retry");

const network = attendeeJoinRefusal("network", "Could not reach the server.");
assert.equal(network.title, "Can't join yet");
assert.equal(network.body, "Could not reach the server.");
assert.equal(network.action, "retry");

const server = attendeeJoinRefusal("internal", "Something went wrong.");
assert.equal(server.action, "retry");
assert.equal(server.body, "Something went wrong.");

const register = attendeeJoinRefusal("not_registered", "You're not registered for this webinar yet.");
assert.equal(register.action, "register");
assert.equal(register.title, "You're not registered yet");

const sameTitle = attendeeJoinRefusal("unknown", "Can't join yet.");
assert.equal(sameTitle.title, "Can't join yet");
assert.equal(sameTitle.body, "");
assert.equal(sameTitle.action, "retry");

// A refresh after the host removed you: said plainly, and no Try again that would only be refused.
const removed = attendeeJoinRefusal("removed", "The host removed you from this session.");
assert.equal(removed.title, "You were removed from this session");
assert.equal(removed.action, "none");

// The on-demand video server: both waits retry by themselves, so no button.
const starting = attendeeJoinRefusal("sfu_starting", "Starting servers… (about 2 minutes).");
assert.equal(starting.title, "Starting servers…");
assert.equal(starting.action, "none");
const failed = attendeeJoinRefusal("sfu_failed", "The video server could not be started.");
assert.equal(failed.title, "The video server couldn't start");
assert.equal(failed.action, "none");

// Past the attendee limit: the title says full, the body carries the limit and who can raise it.
const full = attendeeJoinRefusal(
  "room_full",
  "This webinar is full (50 attendees). Ask the host to raise the limit.",
);
assert.equal(full.title, "The webinar is full");
assert.equal(full.body, "This webinar is full (50 attendees). Ask the host to raise the limit.");

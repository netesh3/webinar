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

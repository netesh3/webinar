/* A meeting guest at the door: waiting polls, a denial stops for good, full / locked / busy
 * retry, ended is final, and a missing or foreign key goes back to the name field.
 *
 * Run: node --experimental-strip-types --no-warnings lib/meeting-lobby.test.mts
 */

import assert from "node:assert/strict";
import {
  DENIED_TITLE,
  ENDED_TITLE,
  MEETING_POLL_MS,
  WAITING_TITLE,
  knockGoesIn,
  lobbyScreen,
} from "./meeting-lobby.ts";

// Waiting keeps polling, and offers nothing to click.
const waiting = lobbyScreen("waiting_for_host", "The host will let you in soon.");
assert.equal(waiting.phase, "waiting");
assert.equal(waiting.title, WAITING_TITLE);
assert.equal(waiting.poll, true);
assert.equal(waiting.retry, false);
assert.equal(waiting.knockAgain, false);

// A server warming up is still waiting, from the guest's side.
assert.equal(lobbyScreen("sfu_starting", "").poll, true);
assert.equal(lobbyScreen("not_started", "").phase, "waiting");

// Denied is terminal: no polling, no retry, and no fresh knock from the same browser.
const denied = lobbyScreen("lobby_denied", "The host didn't let you into this meeting.");
assert.equal(denied.phase, "denied");
assert.equal(denied.title, DENIED_TITLE);
assert.deepEqual([denied.poll, denied.retry, denied.knockAgain], [false, false, false]);

// Full carries the server's sentence (it names the cap) and offers a retry.
const full = lobbyScreen(
  "meeting_full",
  "This meeting is full: it holds 10 people at once, including the host.",
);
assert.equal(full.phase, "full");
assert.match(full.body, /10 people/);
assert.equal(full.retry, true);
assert.equal(full.poll, false);

// Ended, from either spelling, is final.
for (const code of ["meeting_ended", "ended", "not_joinable"]) {
  const s = lobbyScreen(code, "");
  assert.equal(s.phase, "ended", code);
  assert.equal(s.title, ENDED_TITLE);
  assert.equal(s.retry || s.poll || s.knockAgain, false, code);
}

// Locked and a crowded lobby can clear: retry.
assert.equal(lobbyScreen("locked", "").retry, true);
assert.equal(lobbyScreen("lobby_full", "").phase, "busy");
assert.equal(lobbyScreen("lobby_full", "").retry, true);

// Removed may ask again; that is a new request the host answers.
const removed = lobbyScreen("removed", "");
assert.equal(removed.knockAgain, true);
assert.equal(removed.retry, false);

// No key, an unknown key, or another door's "knock instead": the name field.
for (const code of [
  "not_registered",
  "no_join_key",
  "invalid_join_key",
  "registration_required",
  "meeting_knock",
  "not_found",
]) {
  assert.equal(lobbyScreen(code, "whatever").phase, "knock", code);
}

// Anything else shows the server's sentence and a retry, never an empty card.
const other = lobbyScreen("rate_limited", "Slow down.");
assert.equal(other.phase, "error");
assert.equal(other.body, "Slow down.");
assert.equal(other.retry, true);
assert.equal(lobbyScreen("boom", "").body !== "", true);

// The body never repeats the title.
assert.equal(lobbyScreen("meeting_full", "This meeting is full").body, "");

// Both knock answers lead to the join poll.
assert.equal(knockGoesIn("waiting"), true);
assert.equal(knockGoesIn("admitted"), true);
assert.equal(knockGoesIn(""), false);

assert.equal(MEETING_POLL_MS, 3_000);

console.log("meeting-lobby: ok");

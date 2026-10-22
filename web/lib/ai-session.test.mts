import assert from "node:assert/strict";
import {
  AI_OFF_CONFIRM,
  AI_OFF_THIS_SESSION_TOOLTIP,
  AI_TOGGLE_TOOLTIP,
  aiLockedOff,
  aiToggleVisible,
  captionEngine,
  sessionAIOn,
} from "./ai-session.ts";

// The switch: host and co-host (isHost), and only when the account has AI.
assert.equal(aiToggleVisible(true, { aiAvailable: true }), true);
assert.equal(aiToggleVisible(true, { aiAvailable: false }), false);
assert.equal(aiToggleVisible(false, { aiAvailable: true }), false);
assert.equal(aiToggleVisible(false, { aiAvailable: false }), false);
assert.match(AI_TOGGLE_TOOLTIP, /keep this session out of AI/);

const c = (captionsEnabled: boolean, aiEnabled: boolean, serverCaptions = false) => ({
  captionsEnabled,
  aiEnabled,
  serverCaptions,
});

// Nothing wanted: nothing runs.
assert.deepEqual(captionEngine(c(false, false), true), { run: false, display: false, store: false });
// AI on, captions hidden: runs silently, stores, broadcasts nothing.
assert.deepEqual(captionEngine(c(false, true), true), { run: true, display: false, store: true });
// Captions shown: runs and broadcasts, as before; with AI on too it is still the one engine.
assert.deepEqual(captionEngine(c(true, false), true), { run: true, display: true, store: true });
assert.deepEqual(captionEngine(c(true, true), true), { run: true, display: true, store: true });
// The server agent is live: no browser runs, whatever is wanted.
assert.equal(captionEngine(c(true, true, true), true).run, false);
assert.equal(captionEngine(c(false, true, true), true).run, false);
// Only someone publishing a microphone transcribes.
assert.equal(captionEngine(c(true, true), false).run, false);
// AI off once during the live session and back on: the session is out of AI, so nothing is
// captured for it; captions shown still run the engine for display.
assert.equal(captionEngine({ ...c(false, true), aiOffThisSession: true }, true).run, false);
assert.equal(captionEngine({ ...c(true, true), aiOffThisSession: true }, true).display, true);

// What the room treats as "AI in use": aiEnabled reading true is not enough once the session
// was switched off while live (instant-webinar-4277, 2026-10-22: off then on at 16:57:49/50,
// switch showed on, the server answered every Q&A assistant read with enabled:false).
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true }), true);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true, aiOffThisSession: false }), true);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true, aiOffThisSession: true }), false);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: false }), false);
assert.equal(sessionAIOn({ aiAvailable: false, aiEnabled: true }), false);

// The switch is locked off only while live, and only for an account with AI.
assert.equal(aiLockedOff({ aiAvailable: true, aiOffThisSession: true }, "live"), true);
assert.equal(aiLockedOff({ aiAvailable: true, aiOffThisSession: true }, "scheduled"), false);
assert.equal(aiLockedOff({ aiAvailable: true, aiOffThisSession: true }, null), false);
assert.equal(aiLockedOff({ aiAvailable: true }, "live"), false);
assert.equal(aiLockedOff({ aiAvailable: false, aiOffThisSession: true }, "live"), false);
assert.match(AI_OFF_CONFIRM, /rest of this session/);
assert.match(AI_OFF_THIS_SESSION_TOOLTIP, /stays off until the session ends/);

console.log("ai-session: ok");

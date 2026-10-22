import assert from "node:assert/strict";
import {
  AI_OFF_CONFIRM,
  AI_PAUSED_NOTE,
  AI_PAUSED_TOOLTIP,
  AI_RESUME_CONFIRM,
  AI_TOGGLE_TOOLTIP,
  aiPaused,
  aiPausedResultsNote,
  aiToggleConfirm,
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
// Paused (the server's mark while live): nothing is captured for the AI; captions shown still
// run the engine for display.
assert.equal(captionEngine({ ...c(false, true), aiOffThisSession: true }, true).run, false);
assert.equal(captionEngine({ ...c(true, true), aiOffThisSession: true }, true).display, true);
// Resumed: capture again.
assert.equal(captionEngine({ ...c(false, true), aiOffThisSession: false }, true).store, true);

// What the room treats as "AI in use now": the switch on and not paused (instant-webinar-4277:
// a switch reading on over a session the server treated as off hid the assistant silently).
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true }), true);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true, aiOffThisSession: false }), true);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: true, aiOffThisSession: true }), false);
assert.equal(sessionAIOn({ aiAvailable: true, aiEnabled: false }), false);
assert.equal(sessionAIOn({ aiAvailable: false, aiEnabled: true }), false);

// Paused: only while live, only for an account with AI; resuming clears it.
assert.equal(aiPaused({ aiAvailable: true, aiEnabled: false, aiOffThisSession: true }, "live"), true);
assert.equal(aiPaused({ aiAvailable: true, aiEnabled: false }, "live"), true);
assert.equal(aiPaused({ aiAvailable: true, aiEnabled: true, aiOffThisSession: false }, "live"), false);
assert.equal(aiPaused({ aiAvailable: true, aiEnabled: false, aiOffThisSession: true }, "scheduled"), false);
assert.equal(aiPaused({ aiAvailable: true, aiEnabled: false }, null), false);
assert.equal(aiPaused({ aiAvailable: false, aiEnabled: false }, "live"), false);

// Both directions ask while live, and neither does otherwise.
assert.equal(aiToggleConfirm(true, "live"), AI_OFF_CONFIRM);
assert.equal(aiToggleConfirm(false, "live"), AI_RESUME_CONFIRM);
assert.equal(aiToggleConfirm(true, "scheduled"), null);
assert.equal(aiToggleConfirm(false, null), null);
assert.match(AI_OFF_CONFIRM, /AI pauses until you turn it back on; what's said meanwhile stays out of AI/);
assert.match(AI_RESUME_CONFIRM, /^Resume AI for this session\?/);
assert.match(AI_RESUME_CONFIRM, /Anything said or asked while AI was off stays out of AI\./);
assert.match(AI_PAUSED_TOOLTIP, /paused/);
assert.equal(AI_PAUSED_NOTE, "AI is paused");

// The Results note.
assert.equal(aiPausedResultsNote(undefined), null);
assert.equal(aiPausedResultsNote(0), null);
assert.equal(aiPausedResultsNote(12), "AI was paused for 12 min; that part isn't included.");

console.log("ai-session: ok");

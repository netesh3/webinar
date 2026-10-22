import assert from "node:assert/strict";
import { AI_TOGGLE_TOOLTIP, aiToggleVisible, captionEngine } from "./ai-session.ts";

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

console.log("ai-session: ok");

/* Tests for a simulive's Auto mode on the browser's side: the follow-up call's timing, and the
 * assistant's signature, which must always say it is an assistant. Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  assistantLabelFor,
  assistantSignature,
  autoAnswerDelay,
  autoAnswerDisclosure,
  autoModeAvailable,
  withAutoAnswer,
} from "./qa-auto.ts";

// The delay: only when the server asked, and clamped.
assert.equal(autoAnswerDelay(undefined), null);
assert.equal(autoAnswerDelay({}), null);
assert.equal(autoAnswerDelay({ autoAnswerInMs: 0 }), null);
assert.equal(autoAnswerDelay({ autoAnswerInMs: -5 }), null);
assert.equal(autoAnswerDelay({ autoAnswerInMs: Number.NaN }), null);
assert.equal(autoAnswerDelay({ autoAnswerInMs: 5000 }), 5000);
assert.equal(autoAnswerDelay({ autoAnswerInMs: 1 }), 1000);
assert.equal(autoAnswerDelay({ autoAnswerInMs: 600_000 }), 30_000);

// The signature: sparkle and "assistant", always.
assert.equal(assistantSignature("✨ Asha's assistant"), "✨ Asha's assistant");
assert.equal(assistantSignature("Asha's assistant"), "✨ Asha's assistant");
assert.equal(assistantSignature("Asha"), "✨ Asha (assistant)");
assert.equal(assistantSignature("  "), null);
assert.equal(assistantSignature(undefined), null);
assert.ok((assistantSignature("x".repeat(500)) ?? "").length < 120);

assert.equal(assistantLabelFor("Asha Rao"), "✨ Asha's assistant");
assert.equal(assistantLabelFor("  "), "✨ The host's assistant");
assert.ok(autoAnswerDisclosure("✨ Asha's assistant").includes("“✨ Asha's assistant”"));
assert.ok(autoAnswerDisclosure("✨ Asha's assistant").includes("never as you"));

assert.equal(autoModeAvailable(["ai", "replay_engage"]), true);
assert.equal(autoModeAvailable(["ai"]), false);
assert.equal(autoModeAvailable(["replay_engage"]), false);
assert.equal(autoModeAvailable(null), false);

// The relay: one follow-up call after a question Auto mode took, none otherwise.
{
  const scheduled: number[] = [];
  let triggered = 0;
  const run: (() => void)[] = [];
  const relay = withAutoAnswer(
    async (req: { kind: string }) => (req.kind === "question" ? { recipients: 0, autoAnswerInMs: 5000 } : { recipients: 0 }),
    async () => {
      triggered++;
    },
    (fn, ms) => {
      scheduled.push(ms);
      run.push(fn);
    },
  );
  const res = await relay({ kind: "question" });
  assert.equal(res.autoAnswerInMs, 5000, "the response is passed through");
  await relay({ kind: "chat" });
  assert.deepEqual(scheduled, [5000], "only the question schedules a call");
  assert.equal(triggered, 0, "not before the delay");
  run.forEach((fn) => fn());
  assert.equal(triggered, 1);

  // A failing follow-up is swallowed: the asker's question was already sent.
  const quiet = withAutoAnswer(
    async () => ({ recipients: 0, autoAnswerInMs: 10 }),
    async () => {
      throw new Error("offline");
    },
    (fn) => fn(),
  );
  await quiet({});
  await new Promise((r) => setTimeout(r, 0));
}

console.log("qa-auto: ok");

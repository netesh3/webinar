/* Tests for live-caption interim lines and the edge viewer's caption hold.
 *
 * Run with `make test-web`.
 *
 * Both are timing questions nobody can reproduce by hand: a partial arriving a beat after
 * its own final (which must not put the rougher text back), and a caption reaching an edge
 * viewer whose video is three seconds behind (which must wait for the video, not show the
 * words before they are heard, nor wait so long it lands after them). */

import {
  acceptCaption,
  DEFAULT_LAG_MS,
  EDGE_INGEST_MS,
  edgeHoldMs,
  FINALISED_MEMORY,
  getEdgeVideoDelay,
  MAX_HOLD_MS,
  rememberFinal,
  setEdgeVideoDelay,
  subscribeEdgeVideoDelay,
  type CaptionLine,
} from "./caption-sync.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function line(text: string, extra: Partial<CaptionLine> = {}): CaptionLine {
  return { identity: "user_1", text, at: Date.now(), ...extra };
}

// ---------------------------------------------------------------- partial -> final

{
  const p1 = line("namaste", { id: "user_1:1000", partial: true });
  const p2 = line("namaste doston aaj", { id: "user_1:1000", partial: true });
  const fin = line("Namaste doston, aaj hum", { id: "user_1:1000" });

  ok(acceptCaption(null, p1, []), "a first partial shows");
  ok(acceptCaption(p1, p2, []), "a longer partial of the same line replaces the shorter");
  ok(acceptCaption(p2, fin, []), "the final replaces its partials");
  let finalised = rememberFinal([], fin);
  ok(finalised.includes("user_1:1000"), "the final's id is remembered");
  ok(!acceptCaption(fin, p2, finalised), "a late partial does not replace its final");
  ok(!acceptCaption(fin, p2, []), "nor even before the id is remembered, while the final shows");

  const other = line("Ravi here", { identity: "user_2", id: "user_2:5000" });
  finalised = rememberFinal(finalised, other);
  ok(!acceptCaption(other, p2, finalised), "nor a partial of a line finalised before another speaker's");

  const next = line("next line", { id: "user_1:9000", partial: true });
  ok(acceptCaption(fin, next, finalised), "the next line's partial shows over the last final");

  const browser = line("on-device caption");
  ok(acceptCaption(fin, browser, finalised), "an on-device caption (no id) always shows");
  ok(rememberFinal(finalised, browser) === finalised, "and is not remembered");
  ok(rememberFinal(finalised, next) === finalised, "a partial is not remembered as final");

  let many: readonly string[] = [];
  for (let i = 0; i < FINALISED_MEMORY + 10; i++) many = rememberFinal(many, line("x", { id: `u:${i}` }));
  ok(many.length === FINALISED_MEMORY, "the memory is bounded", `${many.length}`);
  ok(many[many.length - 1] === `u:${FINALISED_MEMORY + 9}`, "keeping the newest");
}

// ---------------------------------------------------------------- edge hold

{
  ok(edgeHoldMs(null, 500) === 0, "no edge player: no hold");
  ok(edgeHoldMs(0, 500) === 0, "a zero delay: no hold");
  ok(edgeHoldMs(Number.NaN, 500) === 0, "an unmeasured delay: no hold");

  // Video 3 s behind live; the line left the server 1.2 s after its speech ended.
  const hold = edgeHoldMs(3, 1200);
  ok(hold === 3000 + EDGE_INGEST_MS - 1200, "held until the video reaches the end of the speech", `${hold}`);

  ok(edgeHoldMs(2, 4000) === 0, "a line older than the video delay shows at once");
  ok(edgeHoldMs(3, undefined) === 3000 + EDGE_INGEST_MS - DEFAULT_LAG_MS, "no lag stamped: a decode's worth assumed");
  ok(edgeHoldMs(3, -50) === 3000 + EDGE_INGEST_MS - DEFAULT_LAG_MS, "a nonsense lag is ignored");
  ok(edgeHoldMs(60, 0) === MAX_HOLD_MS, "a stalled player does not hold a line for a minute");

  // A partial (fresher) is held longer than its final (decoded later), so both land
  // with the video: the partial when the video reaches the words it covers.
  ok(edgeHoldMs(3, 300) > edgeHoldMs(3, 1500), "fresher text waits longer");
}

// ---------------------------------------------------------------- the delay store

{
  let calls = 0;
  const off = subscribeEdgeVideoDelay(() => calls++);
  setEdgeVideoDelay(2.93);
  ok(getEdgeVideoDelay() === 3, "rounded to a quarter second", `${getEdgeVideoDelay()}`);
  setEdgeVideoDelay(3.05);
  ok(calls === 1, "no notification when the rounded delay is unchanged", `${calls}`);
  setEdgeVideoDelay(null);
  ok(getEdgeVideoDelay() === null && calls === 2, "cleared on unmount");
  setEdgeVideoDelay(-1);
  ok(getEdgeVideoDelay() === null, "a negative delay reads as none");
  off();
  setEdgeVideoDelay(4);
  ok(calls === 2, "an unsubscribed listener is not called");
  setEdgeVideoDelay(null);
}

console.log(`caption-sync: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);

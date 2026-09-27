/* Tests for the room's connection toast: a blip that must stay silent, a drop that turns
 * into "back online" in place, and an escalation to "Connection lost".
 *
 * Run with `make test-web`.
 */

import {
  BACK_MS,
  ConnectionToastTracker,
  LOST_AFTER_MS,
  SHOW_AFTER_MS,
  connectionToastText,
  type ConnectionSignal,
  type ConnectionToastView,
} from "./connection-toast.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL  ${what}${detail ? `\n      ${detail}` : ""}`);
}

function phase(view: ConnectionToastView | null): string {
  return view ? view.phase : "none";
}

const A = 5;
const up: ConnectionSignal = { link: "connected", recovering: null, attempts: A };
const sdk: ConnectionSignal = { link: "reconnecting", recovering: null, attempts: A };
const ladder = (n: number): ConnectionSignal => ({ link: "disconnected", recovering: n, attempts: A });

function connected(): ConnectionToastTracker {
  const t = new ConnectionToastTracker();
  t.update({ link: "connecting", recovering: null, attempts: A }, 0);
  t.update(up, 100);
  return t;
}

// ---- first connect is silent until the room greets a presenter
{
  const t = new ConnectionToastTracker();
  t.update({ link: "connecting", recovering: null, attempts: A }, 0);
  ok(phase(t.view()) === "none", "connecting before first join shows nothing");
  t.update(up, 500);
  ok(phase(t.view()) === "none", "first connect alone (an attendee) shows no toast");
  ok(t.nextDeadline() === null, "nothing scheduled after first connect");
}

// ---- a presenter reaching the stage: "You're connected", then gone after BACK_MS
{
  const t = connected();
  ok(t.greet(200) === true, "greet shows");
  ok(phase(t.view()) === "connected", "greeting is the connected phase", phase(t.view()));
  ok(t.nextDeadline() === 200 + BACK_MS, "greeting auto-dismiss scheduled");
  t.tick(200 + BACK_MS - 1);
  ok(phase(t.view()) === "connected", "greeting still up before deadline");
  t.tick(200 + BACK_MS);
  ok(phase(t.view()) === "none", "greeting gone after BACK_MS");
  ok(t.nextDeadline() === null, "nothing scheduled after greeting");
  const text = connectionToastText({ phase: "connected" });
  ok(text.title === "You're connected", "greeting title");
  ok(text.detail.includes("see and hear you"), "greeting says they are live");
  ok(connectionToastText({ phase: "connected" }, false).detail === text.detail, "greeting copy is stage copy regardless of a lagging publisher flag");
}

// ---- the greeting is said once per room: back on stage, or a re-read after a reconnect, is quiet
{
  const t = connected();
  t.greet(200);
  t.tick(200 + BACK_MS);
  ok(t.greet(10_000) === false, "second greet is ignored");
  ok(phase(t.view()) === "none", "no second greeting");
}

// ---- permissions arriving a render before the connection state: greeting held until connected
{
  const t = new ConnectionToastTracker();
  t.update({ link: "connecting", recovering: null, attempts: A }, 0);
  t.greet(50);
  ok(phase(t.view()) === "none", "early greet shows nothing while connecting");
  t.update(up, 100);
  ok(phase(t.view()) === "connected", "early greet shows once connected");
  ok(t.nextDeadline() === 100 + BACK_MS, "early greet timed from the connect");
}

// ---- greeting can be clicked away
{
  const t = connected();
  t.greet(200);
  t.dismiss();
  ok(phase(t.view()) === "none", "greeting can be dismissed");
  ok(t.nextDeadline() === null, "dismissed greeting leaves nothing scheduled");
}

// ---- a drop while the greeting is up flips straight to reconnecting, then says back online
{
  const t = connected();
  t.greet(200);
  t.update(sdk, 1_000);
  ok(phase(t.view()) === "reconnecting", "drop during greeting shows reconnecting at once");
  t.update(up, 2_000);
  ok(phase(t.view()) === "back", "and recovers to back online, not connected");
}

// ---- a greeting raised during an outage is spent silently; the outage flow is unchanged
{
  const t = connected();
  t.update(sdk, 1_000);
  ok(t.greet(1_200) === false, "greet during outage does not show");
  t.tick(1_000 + SHOW_AFTER_MS);
  ok(phase(t.view()) === "reconnecting", "outage still shown");
  t.update(up, 3_000);
  ok(phase(t.view()) === "back", "outage still ends in back online");
}

// ---- after a reconnect, "back online" is not relabelled as a greeting
{
  const t = connected();
  t.greet(200);
  t.tick(200 + BACK_MS);
  t.update(sdk, 5_000);
  t.tick(5_000 + SHOW_AFTER_MS);
  t.update(up, 7_000);
  ok(phase(t.view()) === "back", "reconnect after greeting says back online");
}

// ---- a failed first connect retried by the ladder is the banner's job, not a toast
{
  const t = new ConnectionToastTracker();
  t.update({ link: "connecting", recovering: null, attempts: A }, 0);
  t.update(ladder(1), 100);
  t.tick(5_000);
  ok(phase(t.view()) === "none", "ladder retrying a first connect shows no toast");
  t.update(up, 6_000);
  ok(phase(t.view()) === "none", "first connect after retries still silent");
}

// ---- a short blip never appears
{
  const t = connected();
  t.update(sdk, 1_000);
  ok(phase(t.view()) === "none", "blip hidden at start");
  ok(t.nextDeadline() === 1_000 + SHOW_AFTER_MS, "show deadline scheduled");
  t.tick(1_000 + SHOW_AFTER_MS - 1);
  ok(phase(t.view()) === "none", "blip hidden just under threshold");
  t.update(up, 1_000 + SHOW_AFTER_MS - 1);
  ok(phase(t.view()) === "none", "short blip ends silently — no 'back online'");
  ok(t.nextDeadline() === null, "nothing scheduled after silent blip");
}

// ---- a real drop: reconnecting → back online → gone
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(1_000 + SHOW_AFTER_MS);
  const v = t.view();
  ok(phase(v) === "reconnecting", "reconnecting after threshold", phase(v));
  ok(v?.phase === "reconnecting" && v.attempt === null, "SDK reconnect has no attempt number");
  t.update(up, 3_000);
  ok(phase(t.view()) === "back", "turns into back online");
  ok(t.nextDeadline() === 3_000 + BACK_MS, "back online auto-dismiss scheduled");
  t.tick(3_000 + BACK_MS - 1);
  ok(phase(t.view()) === "back", "back online still up before deadline");
  t.tick(3_000 + BACK_MS);
  ok(phase(t.view()) === "none", "back online gone after BACK_MS");
}

// ---- the SDK gives up, the ladder takes over: one outage, attempt numbers shown
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(2_500);
  t.update(ladder(2), 3_000);
  const v = t.view();
  ok(v?.phase === "reconnecting" && v.attempt === 2, "ladder attempt carried into view");
  ok(connectionToastText(v!).detail.includes("attempt 2 of 5"), "copy names the attempt");
  // Between attempts the room is Connecting; still the same outage.
  t.update({ link: "connecting", recovering: 3, attempts: A }, 3_500);
  ok(phase(t.view()) === "reconnecting", "connecting mid-ladder stays reconnecting");
}

// ---- final attempt escalates to lost
{
  const t = connected();
  t.update(ladder(1), 1_000);
  t.tick(2_000);
  ok(phase(t.view()) === "reconnecting", "ladder rung 1 is reconnecting");
  t.update(ladder(A), 4_000);
  ok(phase(t.view()) === "lost", "final attempt is lost");
  t.update(up, 5_000);
  ok(phase(t.view()) === "back", "recovering from lost still says back online");
}

// ---- a long outage escalates on time alone
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(1_000 + SHOW_AFTER_MS);
  ok(t.nextDeadline() === 1_000 + LOST_AFTER_MS, "lost deadline scheduled once shown");
  t.tick(1_000 + LOST_AFTER_MS);
  ok(phase(t.view()) === "lost", "long SDK reconnect escalates to lost");
  ok(t.nextDeadline() === null, "nothing further scheduled once lost");
}

// ---- dismissing: stays hidden for the outage, but lost breaks through; back is silent
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(2_500);
  t.dismiss();
  ok(phase(t.view()) === "none", "dismissed reconnecting hides");
  t.update(ladder(3), 4_000);
  ok(phase(t.view()) === "none", "still hidden on a later rung");
  t.update(ladder(A), 6_000);
  ok(phase(t.view()) === "lost", "escalation to lost shows despite dismiss");
  t.dismiss();
  ok(phase(t.view()) === "none", "dismissed lost hides");
  t.update(up, 7_000);
  ok(phase(t.view()) === "none", "dismissed outage ends without back online");
}

// ---- dismissing back online
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(2_500);
  t.update(up, 3_000);
  t.dismiss();
  ok(phase(t.view()) === "none", "back online can be clicked away");
  ok(t.nextDeadline() === null, "and leaves nothing scheduled");
}

// ---- a drop while back online is up flips straight back without waiting
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(2_500);
  t.update(up, 3_000);
  t.update(sdk, 3_500);
  ok(phase(t.view()) === "reconnecting", "drop during back online shows reconnecting at once");
}

// ---- a fresh outage after a dismissed one is shown again
{
  const t = connected();
  t.update(sdk, 1_000);
  t.tick(2_500);
  t.dismiss();
  t.update(up, 3_000);
  t.update(sdk, 10_000);
  t.tick(10_000 + SHOW_AFTER_MS);
  ok(phase(t.view()) === "reconnecting", "new outage is not muted by an old dismiss");
}

// ---- offline copy
{
  const back = connectionToastText({ phase: "back" }, false);
  ok(back.detail === "You're watching live again.", "audience back copy does not claim they are seen");
  ok(connectionToastText({ phase: "back" }).detail.includes("see and hear you"), "presenter back copy");
}
{
  const t = connected();
  t.update({ ...sdk, offline: true }, 1_000);
  t.tick(2_500);
  const v = t.view()!;
  ok(connectionToastText(v).detail.startsWith("You're offline"), "offline copy when navigator is offline");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

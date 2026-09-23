/* Leaving a webinar, and the step that now sits in front of it.
 *
 *   NEXT_PUBLIC_DEV_BYPASS_AUTH=1 npm run dev     (in web/)
 *   node e2e/probe-leave-confirm.mjs [base-url]
 *
 * Leave used to be one click and gone, from a button parked at the far right of the control bar
 * — the same corner that holds a window's close control and a fullscreen exit. The whole change
 * is a step between the click and the disconnect, which means the only thing worth asserting is
 * that the click no longer disconnects. Nothing below the pixels can check that.
 *
 * What it asserts, on /preview/room, for each seat:
 *   1. an attendee's click opens a confirmation and does NOT leave the room
 *   2. Stay dismisses it and they are still there
 *   3. Escape dismisses it too
 *   4. the destructive button has focus, so Return confirms without reaching for a mouse
 *   5. Leave actually leaves
 *   6. a panelist is told what an attendee is not: their camera and microphone go with them
 *   7. the host still gets their own menu — End for everyone must not have become one click
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "leaveconfirm-"));
let chrome = null;
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  try { chrome?.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const CDP = 10060 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

let ws;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error("Chrome never exposed a debugging target"); cleanup(1); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
const thrown = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    thrown.push(m.params.exceptionDetails.text ?? "exception");
  }
});
const call = (method, params = {}) =>
  new Promise((res) => { const at = ++id; pending.set(at, res); ws.send(JSON.stringify({ id: at, method, params })); });
const evaluate = async (expression) =>
  (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    ?.result?.result?.value;

async function goto(url) {
  await call("Page.navigate", { url });
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (await evaluate("document.readyState === 'complete'")) break;
  }
  await sleep(2600);
}

await call("Runtime.enable");
await call("Page.enable");

/** The Leave button, by the label the control bar gives it in each role. */
const LEAVE_BUTTON = `[...document.querySelectorAll('button')]
  .find((b) => /^leave (the webinar|or end)/i.test(b.getAttribute('aria-label') ?? ''))`;

/** The confirmation, by its accessible name rather than by markup shape. */
const PANEL = `document.querySelector('[role=dialog][aria-label="Leave the webinar"]')`;

/** Still in the room? The control bar is only rendered while we are. */
const IN_ROOM = `Boolean(${LEAVE_BUTTON})`;

const clickLeave = () => evaluate(`(() => { const b = ${LEAVE_BUTTON}; if (!b) return false; b.click(); return true; })()`);

// ------------------------------------------------------------------ attendee

console.log(`\n== ${BASE}/preview/room?as=attendee`);
await goto(`${BASE}/preview/room?as=attendee`);

if (!(await evaluate(IN_ROOM))) {
  console.error("  no Leave button on the attendee bar — the preview seat may not be wired");
  cleanup(1);
}

/* -------------------------------------- 1. the click confirms instead of leaving */
await clickLeave();
await sleep(900);

const opened = await evaluate(`(() => {
  const p = ${PANEL};
  if (!p) return null;
  return {
    text: p.innerText.replace(/\\n+/g, ' | '),
    buttons: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()),
    focused: document.activeElement?.textContent?.trim() ?? null,
    expanded: ${LEAVE_BUTTON}?.getAttribute('aria-expanded') ?? null,
  };
})()`);

if (!opened) {
  bad("clicking Leave opened no confirmation");
} else {
  console.log(`  panel: ${JSON.stringify(opened.text)}`);
  ok("clicking Leave opens a confirmation");
  (await evaluate(IN_ROOM))
    ? ok("and does NOT leave the room — the click is no longer the disconnect")
    : bad("the room was left anyway, so the confirmation is decoration");
  opened.buttons.some((b) => /^stay$/i.test(b)) && opened.buttons.some((b) => /^leave$/i.test(b))
    ? ok("it offers Stay and Leave")
    : bad(`buttons are ${JSON.stringify(opened.buttons)}`);
  opened.expanded === "true"
    ? ok("the trigger reports aria-expanded=true")
    : bad(`aria-expanded is ${opened.expanded}`);

  /* ------------------------------------------------------------- 4. focus */
  /^leave$/i.test(opened.focused ?? "")
    ? ok("focus is on Leave, so Return confirms what was already asked for")
    : bad(`focus is on ${JSON.stringify(opened.focused)}, not the Leave button`);

  // An attendee is told the cheap truth: they can come back.
  /rejoin|come back/i.test(opened.text)
    ? ok("it says they can rejoin, which is what makes this a speed bump and not a warning")
    : bad("no mention that leaving is undoable");
  // ...and not told about a stage they are not on.
  /camera|microphone/i.test(opened.text)
    ? bad("an attendee is being told their camera and microphone go with them")
    : ok("an attendee is not told about a stage they are not on");
}

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.result?.data) {
  writeFileSync("/tmp/leave-confirm.png", Buffer.from(shot.result.data, "base64"));
  console.log("  screenshot: /tmp/leave-confirm.png");
}

/* ------------------------------------------------------------- 2. Stay */
await evaluate(`(() => {
  [...${PANEL}.querySelectorAll('button')].find((b) => /^stay$/i.test(b.textContent.trim()))?.click();
})()`);
await sleep(700);
(await evaluate(`!${PANEL}`)) && (await evaluate(IN_ROOM))
  ? ok("Stay dismisses it and leaves them where they were")
  : bad("Stay did not dismiss the confirmation");

/* ----------------------------------------------------------- 3. Escape */
await clickLeave();
await sleep(700);
await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(700);
(await evaluate(`!${PANEL}`)) && (await evaluate(IN_ROOM))
  ? ok("Escape dismisses it too")
  : bad("Escape did not dismiss the confirmation");

/* --------------------------------------------------- 5. Leave really leaves */
await clickLeave();
await sleep(700);
await evaluate(`(() => {
  [...${PANEL}.querySelectorAll('button')].find((b) => /^leave$/i.test(b.textContent.trim()))?.click();
})()`);
await sleep(2200);
const left = await evaluate("location.pathname");
left !== "/preview/room"
  ? ok(`confirming leaves — now at ${left}`)
  : bad("confirming did nothing; they are still in the room");

// ------------------------------------------------------------------ panelist

console.log(`\n== ${BASE}/preview/room?as=panelist`);
await goto(`${BASE}/preview/room?as=panelist`);
await clickLeave();
await sleep(900);
const panelist = await evaluate(`(() => { const p = ${PANEL}; return p ? p.innerText.replace(/\\n+/g, ' | ') : null; })()`);
if (!panelist) {
  bad("a panelist gets no confirmation");
} else {
  console.log(`  panel: ${JSON.stringify(panelist)}`);
  /camera|microphone/i.test(panelist)
    ? ok("a panelist is told their camera and microphone go with them")
    : bad("a panelist gets the attendee wording, which understates what their leave does");
}

// ---------------------------------------------------------------------- host

console.log(`\n== ${BASE}/preview/room  (host)`);
await goto(`${BASE}/preview/room`);
await clickLeave();
await sleep(900);
const hostMenu = await evaluate(`(() => {
  const m = document.querySelector('[role=menu][aria-label="Leave options"]');
  return m ? m.innerText.replace(/\\n+/g, ' | ') : null;
})()`);
if (!hostMenu) {
  bad("the host's Leave menu is gone — End for everyone may have become one click");
} else {
  console.log(`  menu: ${JSON.stringify(hostMenu.slice(0, 120))}`);
  /end webinar for everyone/i.test(hostMenu)
    ? ok("the host still gets their own menu, unchanged")
    : bad("the host menu no longer offers End for everyone");
  (await evaluate(`!${PANEL}`))
    ? ok("and not the attendee confirmation as well")
    : bad("the host got both the menu and the confirmation");
}

thrown.length === 0
  ? ok("no uncaught exceptions")
  : bad(`uncaught: ${thrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

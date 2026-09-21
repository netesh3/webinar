/* The low-light control, in the settings panel, in a real browser.
 *
 *   NEXT_PUBLIC_DEV_BYPASS_AUTH=1 npm run dev     (in web/)
 *   node e2e/probe-low-light-ui.mjs [base-url]
 *
 * probe-low-light.mjs proves the curve does the right thing to pixels. It says nothing
 * about whether anybody can reach it, which is the other half and the half that is pixels:
 * a slider that renders off-screen, or one that writes a preference nothing reads, would
 * pass every numeric check in that file.
 *
 * So this loads the bypass preview room, opens Settings, and checks:
 *   1. the control is there, is a range input, and spans the stored 0..100
 *   2. it starts at 0 — nobody's camera is altered until they ask
 *   3. moving it round-trips through the room context: the handle holds its new position
 *      and the readout beside it agrees, so the value a presenter sets is the value the
 *      pipeline would be handed
 *   4. no uncaught exceptions on the way through
 *
 * Two things it deliberately does NOT check, because this harness cannot and a check that
 * appears to is worse than none:
 *
 *   Persistence. preview-room.tsx builds its own RoomUI whose updatePrefs is local React
 *   state (`setPrefs((p) => ({ ...p, ...patch }))`), not the localStorage store the real
 *   room uses — so a storage assertion here would be testing the mock. The new code on that
 *   path is asLowLight, which lib/low-light.test.mts covers; the write itself is the same
 *   updatePrefs that `background` and `noiseSuppression` already ride on.
 *
 *   The published track. This room has no camera and no LiveKit behind it. What the
 *   audience receives is covered from the other end by probe-low-light.mjs, which runs the
 *   shipped shader on real pixels; the seam between them is one argument passed to
 *   useVirtualBackground at two call sites.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "lowlightui-"));
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

const CDP = 9860 + (process.pid % 90);
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
  await sleep(2500);
}

await call("Runtime.enable");
await call("Page.enable");

/** Opens the settings window, whichever control bar button carries it. */
const OPEN_SETTINGS = `(() => {
  const hit = [...document.querySelectorAll('button')].find((b) =>
    /settings/i.test(b.getAttribute('aria-label') ?? '') ||
    /settings/i.test(b.getAttribute('title') ?? '') ||
    /settings/i.test(b.textContent ?? ''));
  if (!hit) return false;
  hit.click();
  return true;
})()`;

/** The slider, found by the accessible name the component gives it. */
const SLIDER = `[...document.querySelectorAll('input[type=range]')]
  .find((el) => /low light/i.test(el.getAttribute('aria-label') ?? ''))`;

console.log(`\n== ${BASE}/preview/room`);
await goto(`${BASE}/preview/room`);

if (!(await evaluate(OPEN_SETTINGS))) {
  console.error("  could not find a Settings button in the control bar");
  cleanup(1);
}
await sleep(1800);

/* ------------------------------------------------- 1. the control is reachable */
const shape = await evaluate(`(() => {
  const el = ${SLIDER};
  if (!el) return null;
  return { min: el.min, max: el.max, step: el.step, value: el.value, type: el.type };
})()`);

if (!shape) {
  bad("no slider labelled for low light in the settings panel");
} else {
  console.log(`  slider: ${JSON.stringify(shape)}`);
  shape.type === "range"
    ? ok("the control is a range input — keyboard-operable for free")
    : bad(`the control is a ${shape.type}`);
  shape.min === "0" && shape.max === "100"
    ? ok("it spans the stored range 0..100")
    : bad(`it spans ${shape.min}..${shape.max}, not the stored 0..100`);

  /* ------------------------------------------------------- 2. off by default */
  shape.value === "0"
    ? ok("it starts at 0 — no camera is altered unasked")
    : bad(`it starts at ${shape.value}, so a first-time presenter is adjusted without asking`);
}

/* -------------------------- 3. moving it round-trips through the room context
 *
 * The handle holding its position is the assertion, not a formality. A range input is
 * uncontrolled by default and will hold whatever it is dragged to on its own — but this one
 * is controlled, its value coming back from prefs through the provider. So a handle that
 * stays at 40 means the write reached the context and the context re-rendered the component
 * with it, and a handle that springs back to 0 means it did not. */
const dragged = await evaluate(`(() => {
  const el = ${SLIDER};
  if (!el) return null;
  // Through the prototype setter, because React tracks the value it last rendered and
  // ignores an input event whose value it thinks it already has.
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, '40');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
if (!dragged) bad("could not move the slider");
await sleep(1200);

const after = await evaluate(`(() => {
  const el = ${SLIDER};
  return {
    value: el ? el.value : null,
    readout: (document.body.innerText.match(/\\b40%/) ?? [null])[0],
  };
})()`);

after?.value === "40"
  ? ok("the controlled handle holds 40 — the write reached the room context")
  : bad(`the handle sprang back to ${after?.value}: the context did not take the write`);
after?.readout === "40%"
  ? ok("the readout agrees, so the amount can be found again next week")
  : bad("no 40% readout next to the slider");

/* Scrolled into view purely for the screenshot. The assertions above read the DOM and do
 * not care where it sits; a person looking at the image does. */
await evaluate(`(() => { const el = ${SLIDER}; el?.scrollIntoView({ block: 'center' }); })()`);
await sleep(700);

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.result?.data) {
  writeFileSync("/tmp/low-light-ui.png", Buffer.from(shot.result.data, "base64"));
  console.log("  screenshot: /tmp/low-light-ui.png");
}

/* ------------------------------------------------------------- 5. exceptions */
thrown.length === 0
  ? ok("no uncaught exceptions")
  : bad(`uncaught: ${thrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

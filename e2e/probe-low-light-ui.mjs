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
 * So this loads the bypass preview room and checks both ways in:
 *
 *   SETTINGS
 *   1. the switch is there and starts off — nobody's camera is altered until they ask
 *   2. no slider until the switch is on, because a slider for a feature that is off is a
 *      control with nothing to control
 *   3. one click turns it on at LOW_LIGHT_DEFAULT_ON, which is the whole point of the
 *      switch: the common case must not ask anybody to choose a number
 *   4. the slider then appears, spans the stored range, and moving it round-trips through
 *      the room context — the handle holds its new position and the readout agrees
 *   5. switching off and back on returns to the amount that was chosen, not the default
 *
 *   THE CAMERA MENU
 *   6. the same switch sits under "Blur my background", and agrees with the setting — one
 *      preference behind both, not two that can disagree
 *
 *   7. no uncaught exceptions on the way through
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

/** The switch. A checkbox inside a label whose text names the feature. */
const SWITCH = `[...document.querySelectorAll('input[type=checkbox]')]
  .find((el) => /adjust for low light/i.test(el.closest('label')?.innerText ?? ''))`;

/* The same switch in the camera menu. MenuToggle renders a <label> wrapping a visually
 * hidden checkbox — not a button and not role=menuitemcheckbox — so this finds the label by
 * its text and reads the real input inside it. */
const MENU_SWITCH = `(() => {
  const label = [...document.querySelectorAll('label')]
    .find((el) => /adjust for low light/i.test(el.textContent ?? ''));
  return label ? label.querySelector('input[type=checkbox]') : null;
})()`;

const LOW_LIGHT_DEFAULT_ON = "50";

console.log(`\n== ${BASE}/preview/room  ·  settings`);
await goto(`${BASE}/preview/room`);

if (!(await evaluate(OPEN_SETTINGS))) {
  console.error("  could not find a Settings button in the control bar");
  cleanup(1);
}
await sleep(1800);

/* ------------------------------------------- 1 & 2. the switch, and only the switch */
const initial = await evaluate(`(() => {
  const sw = ${SWITCH};
  return { hasSwitch: Boolean(sw), checked: sw ? sw.checked : null, hasSlider: Boolean(${SLIDER}) };
})()`);

if (!initial?.hasSwitch) {
  console.error("  no 'Adjust for low light' switch in the settings panel");
  cleanup(1);
}
initial.checked === false
  ? ok("the switch starts off — no camera is altered unasked")
  : bad(`the switch starts ${initial.checked}, so a first-time presenter is adjusted without asking`);
initial.hasSlider === false
  ? ok("no slider while it is off — nothing to control yet")
  : bad("the slider is showing even though the feature is off");

/* ------------------------------------- 3 & 4. one click is enough, then the slider */
await evaluate(`(() => { ${SWITCH}?.click(); })()`);
await sleep(1400);

const switched = await evaluate(`(() => {
  const el = ${SLIDER};
  return {
    checked: ${SWITCH}?.checked ?? null,
    value: el ? el.value : null,
    min: el ? el.min : null,
    max: el ? el.max : null,
    readout: (document.body.innerText.match(/\\b\\d+%/) ?? [null])[0],
  };
})()`);

switched?.checked === true
  ? ok("one click turns it on")
  : bad(`the switch did not take the click (checked=${switched?.checked})`);
switched?.value === LOW_LIGHT_DEFAULT_ON
  ? ok(`it lands on ${LOW_LIGHT_DEFAULT_ON}% without asking anybody to choose a number`)
  : bad(`it landed on ${switched?.value}, not the ${LOW_LIGHT_DEFAULT_ON} default`);
switched?.max === "100"
  ? ok("the revealed slider spans the stored range")
  : bad(`the slider spans ${switched?.min}..${switched?.max}`);

/* The handle holding its position is the assertion, not a formality. A range input is
 * uncontrolled by default and would hold a dragged value on its own — but this one is
 * controlled, its value coming back from prefs through the provider. A handle that stays at
 * 25 means the write reached the context and it re-rendered; one that springs back to 50
 * means it did not. */
await evaluate(`(() => {
  const el = ${SLIDER};
  if (!el) return;
  // Through the prototype setter, because React tracks the value it last rendered and
  // ignores an input event whose value it thinks it already has.
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, '25');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(1200);

const moved = await evaluate(`(() => {
  const el = ${SLIDER};
  return {
    value: el ? el.value : null,
    readout: (document.body.innerText.match(/\\b25%/) ?? [null])[0],
  };
})()`);
moved?.value === "25"
  ? ok("the controlled handle holds 25 — the write reached the room context")
  : bad(`the handle sprang back to ${moved?.value}: the context did not take the write`);
moved?.readout === "25%"
  ? ok("the readout agrees, so the amount can be found again")
  : bad("no 25% readout beside the slider");

/* ------------------------------ 5. off and on again returns to the chosen amount */
await evaluate(`(() => { ${SWITCH}?.click(); })()`);
await sleep(1000);
const offAgain = await evaluate(
  `(() => ({ checked: ${SWITCH}?.checked ?? null, hasSlider: Boolean(${SLIDER}) }))()`,
);
offAgain?.checked === false && offAgain?.hasSlider === false
  ? ok("switching off hides the slider again")
  : bad(`after switching off: checked=${offAgain?.checked} slider=${offAgain?.hasSlider}`);

await evaluate(`(() => { ${SWITCH}?.click(); })()`);
await sleep(1200);
const back = await evaluate(`(() => { const el = ${SLIDER}; return el ? el.value : null; })()`);
back === "25"
  ? ok("switching back on returns to 25, not the default — the choice was remembered")
  : bad(`switching back on gave ${JSON.stringify(back)}, losing the chosen 25`);

/* Scrolled into view purely for the screenshot. The assertions above read the DOM and do
 * not care where it sits; a person looking at the image does. */
await evaluate(`(() => { const el = ${SLIDER}; el?.scrollIntoView({ block: 'center' }); })()`);
await sleep(700);

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.result?.data) {
  writeFileSync("/tmp/low-light-ui.png", Buffer.from(shot.result.data, "base64"));
  console.log("  screenshot: /tmp/low-light-ui.png");
}

/* ------------------------------------------------ 6. the same switch in the camera menu
 *
 * One preference behind both, which is the thing worth checking: two switches that each
 * hold their own idea of whether the feature is on is the bug this would have. The setting
 * above left it ON at 25, so the menu's switch has to already agree before it is touched. */
console.log(`\n== the camera menu`);
const opened = await evaluate(`(() => {
  /* The chevron beside the camera button — "Choose camera" — and NOT the camera button
     itself, which toggles the camera rather than opening anything. Matched on the exact
     label media-toggle.tsx gives it rather than on a guess at the wording. */
  const hit = [...document.querySelectorAll('button[aria-haspopup=menu]')].find((b) =>
    /choose camera/i.test(b.getAttribute('aria-label') ?? ''));
  if (!hit) return false;
  hit.click();
  return true;
})()`);
await sleep(1200);

if (!opened) {
  bad("could not open the camera menu (no options button beside the camera control)");
} else {
  const menu = await evaluate(`(() => {
    const box = ${MENU_SWITCH};
    if (!box) return null;
    const menuEl = box.closest('[role=menu]') ?? box.closest('div');
    const text = (menuEl?.innerText ?? '').replace(/\\n+/g, ' | ');
    // Order within the menu, so "below Blur my background" is asserted rather than assumed.
    const blurAt = text.search(/blur my background|virtual background/i);
    const lightAt = text.search(/adjust for low light/i);
    return { checked: box.checked, text: text.slice(0, 180), blurAt, lightAt };
  })()`);

  if (!menu) {
    bad("no 'Adjust for low light' item in the camera menu");
  } else {
    console.log(`  menu: ${JSON.stringify(menu.text)}`);
    menu.checked === true
      ? ok("the menu switch already reads on — one preference behind both controls")
      : bad(`the menu switch reads ${menu.checked} while the setting is on: two sources of truth`);
    menu.blurAt >= 0 && menu.lightAt > menu.blurAt
      ? ok("it sits directly below the background switch, as asked")
      : bad(`wrong order in the menu: blur at ${menu.blurAt}, low light at ${menu.lightAt}`);

    const menuShot = await call("Page.captureScreenshot", { format: "png" });
    if (menuShot?.result?.data) {
      writeFileSync("/tmp/low-light-menu.png", Buffer.from(menuShot.result.data, "base64"));
      console.log("  screenshot: /tmp/low-light-menu.png");
    }
  }
}

/* ------------------------------------------------------------- 5. exceptions */
thrown.length === 0
  ? ok("no uncaught exceptions")
  : bad(`uncaught: ${thrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

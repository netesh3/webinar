/* Virtual background in the camera menu, in a real browser.
 *
 *   NEXT_PUBLIC_DEV_BYPASS_AUTH=1 npm run dev     (in web/)
 *   node e2e/probe-virtual-background-menu.mjs [base-url]
 *
 * Loads the bypass preview room, opens the camera menu and checks:
 *   1. "Virtual background" sits directly under "Blur my background", and says Off
 *   2. clicking it opens the panel with every built-in still, beside the menu
 *   3. picking a still selects it, turns the blur switch off, and leaves the panel open
 *   4. the row now shows that still's thumbnail
 *   5. turning blur back on clears the still — one choice, not two
 *   6. Escape closes the panel first, then the menu
 *   7. on a phone the panel takes the menu's place, and its back button returns
 *   8. no uncaught exceptions on the way through
 *
 * Screenshots land in $SHOTS (default: a temp dir, printed at the end).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "vbmenu-shots-"));
mkdirSync(SHOTS, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "vbmenu-"));
let chrome = null;
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  try { chrome?.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const CDP = 9760 + (process.pid % 90);
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

async function shot(name) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log(`        shot  ${file}`);
}

const pressEscape = async () => {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
};

await call("Runtime.enable");
await call("Page.enable");

const OPEN_CAMERA_MENU = `(() => {
  const b = [...document.querySelectorAll('button')]
    .find((b) => /choose camera/i.test(b.getAttribute('aria-label') ?? ''));
  if (!b) return false;
  b.click();
  return true;
})()`;
const MENU = `document.querySelector('[role=menu][aria-label="Video devices"]')`;
const PANEL = `document.querySelector('[role=dialog][aria-label="Virtual background"]')`;
const ROW = `[...document.querySelectorAll('button')].find((b) => /^Virtual background/.test(b.innerText.trim()) && b.getAttribute('aria-haspopup') === 'dialog')`;
const BLUR = `(() => {
  const l = [...document.querySelectorAll('label')].find((el) => /blur my background/i.test(el.textContent ?? ''));
  return l ? l.querySelector('input[type=checkbox]') : null;
})()`;
const visible = (sel) => `(() => { const el = ${sel}; if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; })()`;
const tile = (label) => `${PANEL}?.querySelector('button[aria-label="${label}"]')`;

console.log(`\n== ${BASE}/preview/room  ·  desktop`);
await goto(`${BASE}/preview/room`);

if (!(await evaluate(OPEN_CAMERA_MENU))) { bad("no camera menu chevron"); cleanup(1); }
await sleep(300);

// 1. Placement and initial state.
const order = await evaluate(`(() => {
  const m = ${MENU}; if (!m) return null;
  return [...m.querySelectorAll('label, button')].map((el) => el.innerText.trim().split('\\n')[0]);
})()`);
if (!order) { bad("camera menu did not open"); cleanup(1); }
const blurAt = order.findIndex((t) => /blur my background/i.test(t));
check(blurAt >= 0 && /^virtual background/i.test(order[blurAt + 1] ?? ""), `"Virtual background" follows "Blur my background" (${JSON.stringify(order)})`);
check((await evaluate(`${ROW}?.innerText`))?.includes("Off"), `row says "Off" before anything is picked`);

// 2. Open the panel.
await evaluate(`${ROW}.click()`);
await sleep(400);
check(await evaluate(visible(PANEL)), "panel opens");
const tiles = await evaluate(`[...(${PANEL}?.querySelectorAll('button[aria-pressed]') ?? [])].map((b) => b.getAttribute('aria-label'))`);
check(JSON.stringify(tiles) === JSON.stringify(["Office", "Library", "Horizon", "Conference", "Studio", "Sage"]), `every still is offered (${JSON.stringify(tiles)})`);
const besideMenu = await evaluate(`${PANEL}.getBoundingClientRect().left >= ${MENU}.getBoundingClientRect().right`);
check(besideMenu, "panel sits beside the menu, not over it");
check(await evaluate(visible(MENU)), "menu stays visible on desktop");
await shot("1-panel-open");

// 3. Pick a still.
const blurBefore = await evaluate(`${BLUR}?.checked`);
if (!blurBefore) {
  await evaluate(`${BLUR}.click()`);
  await sleep(300);
}
check(await evaluate(`${BLUR}?.checked`), "blur is on before picking a still");
await evaluate(`${tile("Office")}.click()`);
await sleep(600);
check((await evaluate(`${tile("Office")}?.getAttribute('aria-pressed')`)) === "true", "Office is selected");
check((await evaluate(`${BLUR}?.checked`)) === false, "picking a still turns blur off");
check(await evaluate(visible(PANEL)), "panel stays open after a pick");

// 4. Row reflects the choice.
check((await evaluate(`${ROW}?.querySelector('img')?.getAttribute('alt')`)) === "Office", "row shows the Office thumbnail");
await shot("2-office-picked");

// 5. Blur clears the still.
await evaluate(`${BLUR}.click()`);
await sleep(400);
check(await evaluate(`${BLUR}?.checked`), "blur switch turns on");
check((await evaluate(`${tile("Office")}?.getAttribute('aria-pressed')`)) === "false", "turning blur on clears the still");
check((await evaluate(`${ROW}?.innerText`))?.includes("Off"), `row is back to "Off"`);

// 6. Escape backs out one level at a time.
await pressEscape();
check(!(await evaluate(visible(PANEL))) && (await evaluate(visible(MENU))), "first Escape closes the panel, keeps the menu");
await pressEscape();
check(!(await evaluate(visible(MENU))), "second Escape closes the menu");

// 7. Phone width.
console.log(`\n== ${BASE}/preview/room  ·  phone (390×844)`);
await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto(`${BASE}/preview/room`);
await evaluate(OPEN_CAMERA_MENU);
await sleep(300);
await evaluate(`${ROW}.click()`);
await sleep(400);
check(await evaluate(visible(PANEL)), "panel opens on a phone");
check(!(await evaluate(visible(MENU))), "panel takes the menu's place on a phone");
const fits = await evaluate(`(() => { const r = ${PANEL}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
check(fits, "panel fits inside the viewport");
await shot("3-phone-panel");
await evaluate(`${PANEL}.querySelector('button[aria-label="Back to camera menu"]').click()`);
await sleep(300);
check(!(await evaluate(visible(PANEL))) && (await evaluate(visible(MENU))), "back button returns to the menu");

// 8. Nothing threw.
check(thrown.length === 0, `no uncaught exceptions${thrown.length ? `: ${thrown.join(" | ")}` : ""}`);

console.log(`\nScreenshots: ${SHOTS}`);
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
cleanup(fails ? 1 : 0);

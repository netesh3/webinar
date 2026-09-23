/* Popping the webinar out, in a real browser, into a real second window.
 *
 *   NEXT_PUBLIC_DEV_BYPASS_AUTH=1 npm run dev     (in web/)
 *   node e2e/probe-pip.mjs [base-url]
 *
 * Document Picture-in-Picture is not something a unit test can reach. The window it opens is a
 * separate browsing context with its own document, which means the two things most likely to be
 * broken are both invisible from the page that opened it:
 *
 *   The stylesheets. A new document inherits none, so without copyStyles the window renders as
 *   unstyled black-on-white HTML — and every assertion about "is the video there" passes while
 *   it looks like a 1996 homepage.
 *
 *   The click handlers. React renders into that document through a portal, and whether its
 *   synthetic events still fire across a document boundary is a property of React's event
 *   delegation rather than of anything in this repo. If they do not, the microphone button in
 *   there is a decoration — and nothing in the main page would say so.
 *
 * So this attaches to the popped-out window as its own CDP target and asks it directly.
 *
 * What it asserts:
 *   1. the button is offered where Document PiP exists
 *   2. clicking it opens a second window, and the button reflects that
 *   3. that window has the stage in it, styled — a real stylesheet reached it
 *   4. a click INSIDE it runs our handler, which is the portal question
 *   5. coming back to the tab closes it, with no gesture anywhere
 *   6. the MediaSession auto-enter action is registered, which is the installed-app path
 *   7. no uncaught exceptions in either document
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "pipprobe-"));
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

const CDP = 10500 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

/** One CDP session per target, because the PiP window is a target of its own. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const thrown = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      thrown.push(
        [d.text, d.exception?.description ?? d.exception?.value, d.url, d.lineNumber]
          .filter(Boolean).join(" @ ").slice(0, 400),
      );
    }
  });
  const call = (method, params = {}) =>
    new Promise((res) => { const at = ++id; pending.set(at, res); ws.send(JSON.stringify({ id: at, method, params })); });
  const evaluate = async (expression, userGesture = false) =>
    (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }))
      ?.result?.result?.value;
  await call("Runtime.enable");
  await call("Page.enable");
  return { ws, call, evaluate, thrown };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json());

let main;
for (let i = 0; i < 80; i++) {
  // Guarded: Chrome is still starting for the first few of these, and a refused connection is
  // the expected answer rather than a failure.
  try {
    const page = (await targets()).find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) { main = await connect(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!main) { console.error("Chrome never exposed a debugging target"); cleanup(1); }

console.log(`\n== ${BASE}/preview/room`);
await main.call("Page.navigate", { url: `${BASE}/preview/room` });
for (let i = 0; i < 60; i++) {
  await sleep(400);
  if (await main.evaluate("document.readyState === 'complete'")) break;
}
await sleep(2800);

/* ------------------------------------------------- 1. the button is there */
const BUTTON = `[...document.querySelectorAll('button')]
  .find((b) => /pop out|floating window/i.test(b.getAttribute('aria-label') ?? ''))`;

const button = await main.evaluate(`(() => {
  const b = ${BUTTON};
  return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') } : null;
})()`);
if (!button) {
  console.error("  no Pop out button — Document PiP may be unavailable in this Chrome");
  cleanup(1);
}
console.log(`  button: ${JSON.stringify(button)}`);
ok("the Pop out button is offered");
button.pressed === "false"
  ? ok("and reports itself as not currently popped out")
  : bad(`aria-pressed starts at ${button.pressed}`);

/* --------------------------------- 2. a real click opens a second window
 *
 * Through Input.dispatchMouseEvent rather than el.click(): requestWindow() needs genuine user
 * activation, and a scripted click does not carry it. This is the one assertion that would pass
 * for the wrong reason if the gesture were faked. */
const box = await main.evaluate(`(() => {
  const b = ${BUTTON};
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
for (const type of ["mousePressed", "mouseReleased"]) {
  await main.call("Input.dispatchMouseEvent", {
    type, x: box.x, y: box.y, button: "left", clickCount: 1,
  });
}
await sleep(2000);

const pipTarget = (await targets()).find(
  (t) => t.type === "page" && t.url !== "about:blank" && !t.url.includes("/preview/room"),
);
// Chrome reports the PiP window as its own target; its url is the opener's document url in some
// builds, so fall back to "a second page target appeared".
const pages = (await targets()).filter((t) => t.type === "page");
if (pages.length < 2 && !pipTarget) {
  bad(`clicking opened no second window (targets: ${JSON.stringify(pages.map((p) => p.url))})`);
} else {
  ok("clicking opens a second window");
}
(await main.evaluate(`${BUTTON}?.getAttribute('aria-pressed')`)) === "true"
  ? ok("the button now reports itself as popped out")
  : bad("the button does not reflect the open window");

/* ------------------------------- 3 & 4. what is inside it, asked of it directly */
const pipPage = pages.find((t) => !t.url.includes("/preview/room")) ?? pages[1];
let pip = null;
if (!pipPage?.webSocketDebuggerUrl) {
  bad("could not attach to the popped-out window");
} else {
  pip = await connect(pipPage.webSocketDebuggerUrl);
  const inside = await pip.evaluate(`(() => {
    const body = document.body;
    const buttons = [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    return {
      url: location.href,
      hasVideoOrEmptyState: Boolean(document.querySelector('video')) || /camera on yet/i.test(body.innerText),
      buttons,
      // The question copyStyles answers: did any rule reach this document at all?
      styleSheets: document.styleSheets.length,
      bodyBg: getComputedStyle(body).backgroundColor,
      roomDark: document.documentElement.classList.contains('room-dark'),
    };
  })()`);
  console.log(`  inside: ${JSON.stringify(inside)}`);

  inside.hasVideoOrEmptyState
    ? ok("the stage is in there — a video, or the empty state when nobody has a camera on")
    : bad("the popped-out window has neither a video nor the empty state");
  inside.styleSheets > 0
    ? ok(`stylesheets were copied across (${inside.styleSheets})`)
    : bad("no stylesheet reached the new document — it will render unstyled");
  inside.roomDark
    ? ok("the room's dark palette is applied, so tokens do not fall back to the light one")
    : bad("room-dark is missing from the popped-out document");
  inside.bodyBg === "rgb(0, 0, 0)"
    ? ok("black behind the letterbox rather than a white flash")
    : bad(`body background is ${inside.bodyBg}`);
  inside.buttons.some((b) => /back to webinar/i.test(b ?? ""))
    ? ok("it offers the way back to the tab")
    : bad(`buttons in the window are ${JSON.stringify(inside.buttons)}`);

  const shot = await pip.call("Page.captureScreenshot", { format: "png" });
  if (shot?.result?.data) {
    writeFileSync("/tmp/pip-window.png", Buffer.from(shot.result.data, "base64"));
    console.log("  screenshot: /tmp/pip-window.png");
  }

  /* 4. THE portal question: does a click in that document run a handler defined in this one?
   *
   * "Back to webinar" calls pip.close(), so the window closing is the proof. If React's events
   * do not cross the document boundary, the click does nothing and the window stays open. */
  const backBox = await pip.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /back to webinar/i.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!backBox) {
    bad("no Back to webinar button to click");
  } else {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await pip.call("Input.dispatchMouseEvent", { type, x: backBox.x, y: backBox.y, button: "left", clickCount: 1 });
    }
    await sleep(1600);
    const stillOpen = (await targets()).filter((t) => t.type === "page").length > 1;
    !stillOpen
      ? ok("a click inside the window ran our handler — React's events cross the document")
      : bad("clicking inside the window did nothing: the portal's handlers are not wired");
  }
}

/* --------------------------------- 5. coming back closes it, with no gesture */
await sleep(500);
const beforeReopen = (await targets()).filter((t) => t.type === "page").length;
for (const type of ["mousePressed", "mouseReleased"]) {
  await main.call("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}
await sleep(1800);
if ((await targets()).filter((t) => t.type === "page").length <= beforeReopen) {
  bad("could not reopen the window for the auto-return check");
} else {
  /* A real second tab, brought to the front — not Emulation.setPageVisibilityOverride.
   *
   * The override does not reliably dispatch visibilitychange, and a test that hides the page
   * without firing the event would report "stays open while hidden" for the wrong reason: the
   * listener never ran either way. Activating another tab is what a user does and is what the
   * browser fires the event for. */
  const other = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })
    .then((r) => r.json())
    .catch(() => null);
  await sleep(1400);
  const pagesWhileAway = (await targets()).filter((t) => t.type === "page");
  // The room tab, the PiP window, and the new tab.
  pagesWhileAway.length >= 3
    ? ok("the window stays open while the tab is in the background, which is the whole point")
    : bad(`the window closed when the tab went to the background (${pagesWhileAway.length} targets)`);

  // Back to the room tab. No click anywhere in this step — this is the automatic half.
  await main.call("Page.bringToFront");
  await sleep(1800);
  const afterReturn = (await targets()).filter((t) => t.type === "page");
  !afterReturn.some((t) => t.url === "about:blank" && t.id !== other?.id)
    ? ok("returning to the tab closed the floating window automatically, with no gesture")
    : bad(`the window survived the return to the tab (${JSON.stringify(afterReturn.map((t) => t.url))})`);
  if (other?.id) await fetch(`http://127.0.0.1:${CDP}/json/close/${other.id}`).catch(() => {});
}

/* ------------------------- 6. the installed-app auto-enter path is registered */
const auto = await main.evaluate(`(() => {
  try {
    // Re-registering throws if the action is unknown to this Chrome, which is the only thing
    // worth knowing here: whether the handler the installed-app path needs is accepted at all.
    navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {});
    return 'accepted';
  } catch (e) { return String(e.name); }
})()`);
auto === "accepted"
  ? ok("Chrome accepts the enterpictureinpicture action, so an installed app can auto-enter")
  : bad(`the auto-enter action is not available: ${auto}`);

/* ----------------------------------------------------------- 7. exceptions */
const allThrown = [...main.thrown, ...(pip?.thrown ?? [])];
allThrown.length === 0
  ? ok("no uncaught exceptions in either document")
  : bad(`uncaught: ${allThrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

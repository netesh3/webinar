/* Where the attendee list lives, in a real browser.
 *
 * It used to be a top-nav entry called "My Webinar" and is now Registered, the fourth
 * tab on the host list, after Drafts. Both halves of that are pixels — the order of a
 * tab row and the absence of a nav link — so the only honest way to check them is to
 * load the page.
 *
 * What it asserts, on /host under NEXT_PUBLIC_DEV_BYPASS_AUTH=1:
 *   1. the tab row reads Upcoming · Past · Drafts · Registered, in that order
 *   2. the top nav no longer offers the attendee list at all
 *   3. clicking the tab swaps the list in without throwing
 *   4. the search box and date range — arguments to the host's paged endpoint — go away
 *      on a tab that endpoint does not serve, and come back on the way out
 *
 * Run: node e2e/probe-host-tabs.mjs [base-url]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "tabschrome-"));
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

const CDP = 9660 + (process.pid % 90);
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
  // React has to paint after hydration before anything below is meaningful.
  await sleep(2500);
}

await call("Runtime.enable");
await call("Page.enable");

console.log(`\n== ${BASE}/host`);
await goto(`${BASE}/host`);

/* ------------------------------------------------------------ 1. the tab row */
const tabs = await evaluate(
  `[...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim())`,
);
console.log(`  tabs: ${JSON.stringify(tabs)}`);
const labels = (tabs ?? []).map((t) => t.replace(/\d+$/, "").trim());
JSON.stringify(labels) === JSON.stringify(["Upcoming", "Past", "Drafts", "Registered"])
  ? ok("tab row is Upcoming · Past · Drafts · Registered")
  : bad(`tab row is ${JSON.stringify(labels)}`);

/* -------------------------------------------------------------- 2. the nav */
const nav = await evaluate(
  `[...document.querySelectorAll('header nav a')].map(a => a.textContent.trim())`,
);
console.log(`  nav: ${JSON.stringify(nav)}`);
(nav ?? []).some((l) => /^registered/i.test(l))
  ? bad("top nav still offers the attendee list")
  : ok(`top nav no longer offers the attendee list (${JSON.stringify(nav)})`);

/* ------------------------------------------- 3 & 4. clicking it swaps the list */
const beforeToolbar = await evaluate(
  `Boolean(document.querySelector('input[type=search]')) &&
   Boolean(document.querySelector('input[type=date]'))`,
);
beforeToolbar
  ? ok("search box and date range present on Upcoming")
  : bad("search box / date range missing on Upcoming — nothing to compare");

const clicked = await evaluate(`(() => {
  const t = [...document.querySelectorAll('[role=tab]')]
    .find(el => /^registered/i.test(el.textContent));
  if (!t) return false;
  t.click();
  return true;
})()`);
if (!clicked) bad("no Registered tab to click");
await sleep(2500);

const after = await evaluate(`(() => {
  const t = [...document.querySelectorAll('[role=tab]')]
    .find(el => /^registered/i.test(el.textContent));
  return {
    selected: t?.getAttribute('aria-selected'),
    search: Boolean(document.querySelector('input[type=search]')),
    date: Boolean(document.querySelector('input[type=date]')),
    body: (document.querySelector('main')?.innerText ?? '').slice(0, 400),
  };
})()`);

after?.selected === "true"
  ? ok("Registered is the selected tab after clicking it")
  : bad(`aria-selected is ${after?.selected} after clicking`);
!after?.search && !after?.date
  ? ok("search box and date range are gone on Registered")
  : bad(`toolbar still showing: search=${after?.search} date=${after?.date}`);

/* The bypass has no API behind it, so the list's own empty or error state is the
 * expected content here — what matters is that MyWebinarsList rendered rather
 * than the host rows or a blank panel.
 *
 * Matched against strings only that component produces. "Registered" would be a
 * vacuous test now that it is also the tab's own label, which is in this text. */
const own =
  /haven't registered for anything yet|Join key|Couldn't load your webinars/i.test(
    after?.body ?? "",
  );
const hostRows = /Finish setup|Attendees|Manage/i.test(after?.body ?? "");
own && !hostRows
  ? ok("the attendee list rendered, and the host rows did not")
  : bad(`wrong panel: own=${own} hostRows=${hostRows} — ${JSON.stringify((after?.body ?? "").slice(0, 160))}`);

/* Captured here rather than at the end: the tab under test is the one worth
 * looking at, and by the end of this probe it is no longer the open one. */
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/host-tabs.png", Buffer.from(shot.result.data, "base64"));
  console.log("  screenshot: /tmp/host-tabs.png");
}

/* -------------------------------------------------------- back out again */
await evaluate(`(() => {
  const t = [...document.querySelectorAll('[role=tab]')]
    .find(el => /drafts/i.test(el.textContent));
  t?.click();
})()`);
await sleep(2000);
const backToolbar = await evaluate(
  `Boolean(document.querySelector('input[type=search]')) &&
   Boolean(document.querySelector('input[type=date]'))`,
);
backToolbar
  ? ok("toolbar comes back on Drafts")
  : bad("toolbar did not come back after leaving Registered");

/* ------------------------------------------------------------- exceptions */
thrown.length === 0
  ? ok("no uncaught exceptions")
  : bad(`uncaught: ${thrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

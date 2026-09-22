/* The attendance table, in a real browser.
 *
 *   NEXT_PUBLIC_DEV_BYPASS_AUTH=1 npm run dev     (in web/)
 *   node e2e/probe-attendance-ui.mjs [base-url]
 *
 * The arithmetic is covered from the other end: internal/api/attendance_test.go writes visits
 * at chosen times against a real database and reads the report back, which is where the
 * clipping, the rounding and the roles are proved. What that cannot see is whether anybody can
 * READ the result — a total that disagrees with its own brackets is the feature, and a table
 * that shows the two without showing why they differ is the feature failing quietly.
 *
 * What it asserts, on the ended fixture under auth bypass:
 *   1. the table has In, Out, Total and Visits columns
 *   2. a rejoiner's Total is visibly LESS than their In-to-Out span — the whole point
 *   3. only rows with more than one visit are expandable, and expanding one reveals every
 *      in/out pair it claimed to have
 *   4. somebody with no departure reads as "still in" rather than as a made-up time
 *   5. the host is listed and labelled, and is NOT in the attended count above
 *   6. no uncaught exceptions
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "attendanceui-"));
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

const CDP = 9960 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1100",
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
  await sleep(3000);
}

await call("Runtime.enable");
await call("Page.enable");

console.log(`\n== ${BASE}/host/preview-past?tab=report`);
await goto(`${BASE}/host/preview-past?tab=report`);

/** Reads the table by its headers, so a column reordered in the markup is still found. */
const TABLE = `(() => {
  const table = [...document.querySelectorAll('table')].find((t) =>
    /\\bIn\\b/.test(t.tHead?.innerText ?? '') && /Visits/.test(t.tHead?.innerText ?? ''));
  if (!table) return null;
  const headers = [...table.tHead.rows[0].cells].map((c) => c.innerText.trim());
  const col = (name) => headers.indexOf(name);
  const rows = [...table.tBodies[0].rows].map((tr) => ({
    cells: [...tr.cells].map((c) => c.innerText.trim()),
    span: tr.cells.length === 1 ? tr.cells[0].innerText.trim() : null,
  }));
  return { headers, rows, in: col('In'), out: col('Out'), total: col('Total'), visits: col('Visits') };
})()`;

const t = await evaluate(TABLE);
if (!t) {
  console.error("  no attendance table on the report tab");
  cleanup(1);
}

/* ------------------------------------------------------------- 1. the columns */
console.log(`  headers: ${JSON.stringify(t.headers)}`);
["Name", "In", "Out", "Total", "Visits"].every((h) => t.headers.includes(h))
  ? ok("the table carries Name, In, Out, Total and Visits")
  : bad(`missing columns: ${JSON.stringify(t.headers)}`);

/** Minutes out of "1 hr 4 min" / "42 min". */
const minutes = (s) => {
  const hr = /(\d+)\s*hr/.exec(s);
  const min = /(\d+)\s*min/.exec(s);
  return (hr ? Number(hr[1]) * 60 : 0) + (min ? Number(min[1]) : 0);
};
/** Minutes since midnight out of "3:32 pm" / "15:32". */
const clock = (s) => {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  if (/pm/i.test(m[3] ?? "") && h !== 12) h += 12;
  if (/am/i.test(m[3] ?? "") && h === 12) h = 0;
  return h * 60 + Number(m[2]);
};

const named = (name) => t.rows.find((r) => r.cells[0]?.startsWith(name));

/* -------------------------- 2. the total is less than the span, for a rejoiner */
const rejoiner = named("Amlesh Kumar");
if (!rejoiner) {
  bad("no row for the rejoining attendee");
} else {
  const total = minutes(rejoiner.cells[t.total]);
  const span = clock(rejoiner.cells[t.out]) - clock(rejoiner.cells[t.in]);
  console.log(`  rejoiner: in ${rejoiner.cells[t.in]} out ${rejoiner.cells[t.out]} total ${rejoiner.cells[t.total]} visits ${rejoiner.cells[t.visits]}`);
  total < span
    ? ok(`total (${total} min) is less than the in-to-out span (${span} min) — the gap is not counted`)
    : bad(`total ${total} min vs span ${span} min: the gap between visits is still being counted`);
  rejoiner.cells[t.visits] === "3"
    ? ok("the row says how many visits there were")
    : bad(`visit count reads ${JSON.stringify(rejoiner.cells[t.visits])}, want 3`);
}

/* ------------------------------------------- 3. expanding reveals every visit */
const before = t.rows.length;
const expanded = await evaluate(`(() => {
  const tr = [...document.querySelectorAll('table tbody tr')]
    .find((r) => (r.cells[0]?.innerText ?? '').startsWith('Amlesh Kumar'));
  if (!tr) return false;
  tr.click();
  return true;
})()`);
if (!expanded) bad("could not click the rejoiner's row");
await sleep(900);

const after = await evaluate(TABLE);
const detail = after?.rows.find((r) => r.span && r.span.includes("→"));
after.rows.length === before + 1
  ? ok("expanding adds exactly one detail row")
  : bad(`rows went ${before} -> ${after?.rows.length}, want one more`);
if (!detail) {
  bad("the expanded row shows no in/out pairs");
} else {
  const arrows = (detail.span.match(/→/g) ?? []).length;
  arrows === 3
    ? ok("all three visits are listed, each with its own in and out")
    : bad(`${arrows} visit lines in the detail row, want 3: ${JSON.stringify(detail.span)}`);
}

/* A row with ONE visit has nothing to reveal, and must not pretend otherwise. */
const single = named("Sunayana G");
if (!single) {
  bad("no row for the single-visit attendee");
} else {
  const rowsNow = after.rows.length;
  await evaluate(`(() => {
    const tr = [...document.querySelectorAll('table tbody tr')]
      .find((r) => (r.cells[0]?.innerText ?? '').startsWith('Sunayana G'));
    tr?.click();
  })()`);
  await sleep(700);
  const t3 = await evaluate(TABLE);
  t3.rows.length === rowsNow
    ? ok("a single-visit row is not expandable — nothing to open, so nothing opens")
    : bad(`clicking a single-visit row changed the table: ${rowsNow} -> ${t3.rows.length}`);
}

/* --------------------------------------- 4. no departure reads as "still in" */
const stillIn = named("Guest");
if (!stillIn) {
  bad("no row for the attendee who never left");
} else {
  /still in/i.test(stillIn.cells[t.out])
    ? ok('an absent departure reads as "still in" rather than a made-up time')
    : bad(`Out reads ${JSON.stringify(stillIn.cells[t.out])} for somebody who never left`);
}

/* ------------------------------- 5. the host is labelled, and not in the count */
const host = named("Preview Host");
if (!host) {
  bad("the host is not listed — \"was my panelist there?\" is unanswerable");
} else {
  /host/i.test(host.cells[0])
    ? ok("the host is listed and labelled")
    : bad(`the host row carries no role label: ${JSON.stringify(host.cells[0])}`);
}
const attendedStat = await evaluate(
  `(() => {
     const el = [...document.querySelectorAll('div')].find((d) =>
       d.children.length === 0 && /^Attended$/.test(d.innerText.trim()));
     return el?.parentElement?.innerText.replace(/\\n/g, ' ') ?? null;
   })()`,
);
console.log(`  attended stat: ${JSON.stringify(attendedStat)}`);
attendedStat && /\b3\b/.test(attendedStat)
  ? ok("Attended counts the 3 attendees, not the 4 people in the table")
  : bad(`Attended reads ${JSON.stringify(attendedStat)}; the host may be inside the count`);

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.result?.data) {
  writeFileSync("/tmp/attendance-ui.png", Buffer.from(shot.result.data, "base64"));
  console.log("  screenshot: /tmp/attendance-ui.png");
}

/* ------------------------------------------------------------- 6. exceptions */
thrown.length === 0
  ? ok("no uncaught exceptions")
  : bad(`uncaught: ${thrown.slice(0, 3).join(" | ")}`);

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);

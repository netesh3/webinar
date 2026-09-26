/* Click the demo in a real browser and assert what happened:
 *
 *     node scripts/verify.mjs
 *
 * The point is the last two checks — every button on every screen is clicked, and any that
 * produced no navigation, no DOM mutation and no toast is reported. That is what keeps
 * "no click is silently dead" true rather than aspirational, and it is why demo.js can be
 * written generically: if a heuristic stops matching a screen, this says so.
 *
 * Chrome over CDP, driven with Node 22's global WebSocket — there is no puppeteer in this
 * repo and this needs no dependency. Asserts against window.__demo where it can, so the
 * checks use the demo's own idea of a row rather than a second copy of the logic. */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "screens");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  `--remote-debugging-port=${PORT}`,
  "--remote-allow-origins=*",
  // A real viewport, not the headless 800x600 default: demo.js finds the canvas by looking
  // for the biggest scroll box on the page, and at 800x600 the spacious canvas is too small
  // to qualify — so a cramped window would fail a check the browser passes.
  "--window-size=1600,1200",
  "--user-data-dir=/tmp/cdp-verify-profile",
  "about:blank",
]);
chrome.stderr.on("data", () => {});

async function version() {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("chrome never came up");
}
const { webSocketDebuggerUrl } = await version();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
let navSeen = false;
const waiting = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const { res, rej } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
  if (m.method === "Runtime.exceptionThrown")
    errors.push(m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push(m.params.args.map((a) => a.value || a.description).join(" "));
  // Whether a click went somewhere is Chrome's answer to give, not something to poll for:
  // reading location.pathname straight after the click still shows the old page, because
  // the navigation has only been requested. The sweep reads this flag instead.
  if (/^Page\.(frameRequestedNavigation|frameStartedNavigating|frameNavigated|loadEventFired)$/.test(m.method)) navSeen = true;
};
function send(method, params = {}, sessionId) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  // A command can go unanswered when a click navigates the page out from under it, so
  // every call gives up rather than hanging the whole sweep.
  return new Promise((res, rej) => {
    waiting.set(mid, { res, rej });
    setTimeout(() => {
      if (waiting.has(mid)) {
        waiting.delete(mid);
        rej(new Error(`timeout: ${method}`));
      }
    }, 8000);
  });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
// Export buttons build a real CSV and click a real object URL, so the sweep would otherwise
// leave a pile of files in whatever Chrome considers its download folder. Refusing the
// download does not stop the Blob being built, which is the part worth asserting.
await send("Browser.setDownloadBehavior", { behavior: "deny" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
  return r.result.value;
}
async function open(slug) {
  errors.length = 0;
  await send("Page.navigate", { url: `file://${DIR}/${slug}.html` }, sessionId);
  for (let i = 0; i < 60; i++) {
    await sleep(40);
    try {
      if ((await evaluate("document.readyState")) === "complete") break;
    } catch {
      /* the old execution context went away mid-navigation */
    }
  }
  await sleep(150); // let the Tailwind CDN land, so geometry checks are real
  navSeen = false;
}

/* Injected helpers, kept as source so every evaluate() is self-contained. */
const H = `
  const lab = el => { const c = el.cloneNode(true);
    c.querySelectorAll('.material-symbols-outlined').forEach(i => i.remove());
    return (c.textContent || '').replace(/\\s+/g, ' ').trim(); };
  const clickable = () => [...document.querySelectorAll('button')].filter(b => !b.closest('#demo-switcher'));
  // Spaces are squashed out of both sides before comparing: "Status: All" is drawn as two
  // adjacent spans with no whitespace between them, so its textContent is "Status:All".
  const byLabel = (t, sel) => { const want = t.toLowerCase().replace(/\\s+/g, '');
    return [...document.querySelectorAll(sel || 'button, a')]
      .filter(e => !e.closest('#demo-switcher'))
      .find(e => lab(e).toLowerCase().replace(/\\s+/g, '') === want); };
  const toasts = () => [...document.querySelectorAll('div')]
    .filter(d => d.style.background === 'rgb(11, 28, 48)').map(d => d.textContent);
  const rows = () => { const t = [...document.querySelectorAll('tbody')].sort((a,b) => b.rows.length - a.rows.length)[0];
    return t ? [...t.rows].filter(r => r.style.display !== 'none').length : 0; };
  const menus = () => [...document.querySelectorAll('body > div')]
    .filter(d => d.style.position === 'fixed' && d.querySelector('button') && d.id !== 'demo-switcher');
`;
const ev = (body) => evaluate(`(() => { ${H} ${body} })()`);

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++;
  else failures.push(name + (detail ? ` — ${detail}` : ""));
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail && !ok ? " — " + detail : ""}`);
}
const click = (label, sel) =>
  ev(`const el = byLabel(${JSON.stringify(label)}, ${JSON.stringify(sel || null)});
      if (!el) return 'missing'; el.click(); return 'clicked';`);
const clickSel = (sel) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`);
const where = () => evaluate("location.pathname.split('/').pop()");
const lastToast = () => ev("return toasts().slice(-1)[0] || '';");
/* For the handful of checks that have to await something in the page — reading back the Blob
 * an export built, mainly. Same injected helpers, an async body. */
const evAsync = (body) => evaluate(`(async () => { ${H} ${body} })()`);

/* ------------------------------------------------------- a click that goes somewhere */
await open("dashboard");
check("dashboard loads with no JS error", errors.length === 0, errors[0]);
check("demo.js is on the page", await evaluate("!!document.querySelector('script[data-demo]')"));
check("dashboard: “+ New Journey” exists", (await click("+ New Journey")) === "clicked");
await sleep(400);
check("dashboard: “+ New Journey” → the create-journey modal", (await where()) === "modal-create-journey.html", await where());

await open("journeys");
await open("modal-create-journey");
await click("Cancel");
await sleep(400);
check("modal: Cancel goes back where you came from", (await where()) === "journeys.html", await where());

await open("settings");
await click("Manage Numbers & Templates in Hub");
await sleep(400);
check("settings: “Manage Numbers & Templates in Hub” → the WhatsApp hub", (await where()) === "whatsapp-hub.html", await where());

await open("campaigns");
await click("View Broadcast Logs");
await sleep(400);
check("campaigns: “View Broadcast Logs” → the execution logs", (await where()) === "exec-logs.html", await where());

// "Edit Step" is step-branch-rules' own heading; the builder's way in is Configure (3).
await open("journey-builder");
await click("Configure (3)");
await sleep(400);
check("journey-builder: “Configure (3)” → the branch rules screen", (await where()) === "step-branch-rules.html", await where());

/* --------------------------------------- the export's own script still wins where it exists */
await open("journeys");
check("journeys: the export's own modal starts hidden", await evaluate("document.getElementById('create-journey-modal').classList.contains('hidden')"));
await click("Create Journey");
await sleep(250);
check(
  "journeys: “Create Journey” opens the export's OWN modal instead of navigating",
  !(await evaluate("document.getElementById('create-journey-modal').classList.contains('hidden')")) && (await where()) === "journeys.html",
  await where(),
);
check("journeys: demo.js did not also toast over it", (await lastToast()) === "", await lastToast());

await open("contacts");
check(
  "contacts: demo.js leaves the rows to the export's own selectContact()",
  await evaluate(`__demo.isOwned(document.querySelector('[onclick^="selectContact"]'))`),
);
await clickSel('[onclick^="selectContact"]');
await sleep(250);
check(
  "contacts: a row click opens the export's own drawer and raises no demo toast",
  !(await evaluate("document.getElementById('contact-drawer').classList.contains('hidden')")) && (await lastToast()) === "",
  await lastToast(),
);

await open("campaigns");
await clickSel("#campaign-rows tr");
await sleep(250);
check("campaigns: a row click still opens the export's own preview panel", await evaluate("document.getElementById('campaign-preview-panel').classList.contains('flex')"));

/* ------------------------------------------------------------------------ tabs filter rows */
await open("templates");
const tBefore = await ev("return rows();");
await click("Pending (2)");
await sleep(250);
const tAfter = await ev("return rows();");
check("templates: the “Pending (2)” tab filters the list", tAfter > 0 && tAfter < tBefore, `${tBefore} → ${tAfter}`);
await click("All (14)");
await sleep(250);
check("templates: “All” restores every row", (await ev("return rows();")) === tBefore);

/* exec-logs is a BROKEN export, and it is here to prove the broken case is handled rather
 * than patched: its script binds `searchInput` where the markup says id="logSearchInput", so
 * it throws at that line and every control it would have wired after it is dead. The guard
 * wire.py puts at the top of <head> records the failure; demo.js reads it and takes the
 * screen over, except for the inline onclick handlers, which are checked one by one — and
 * filterByTab is a hoisted function declaration, so the tabs really do still work. */
await open("exec-logs");
const logErr = await evaluate("(window.__demoErrors || [])[0] || ''");
check("exec-logs: the guard records that the export's own script threw", /addEventListener/.test(logErr), logErr || "no error recorded");
check("exec-logs: its hoisted filterByTab survived the failure", (await evaluate("typeof window.filterByTab")) === "function");
const logRows = `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Failed');
  const r = __demo.rowsNear(b) || []; return { total: r.length, shown: r.filter(x => x.style.display !== 'none').length, owned: __demo.isOwned(b) }; })()`;
const lBefore = await evaluate(logRows);
check("exec-logs: the tabs are left to that surviving inline handler", lBefore.owned === true, JSON.stringify(lBefore));
await click("Failed");
await sleep(250);
const lAfter = await evaluate(logRows);
check(
  "exec-logs: the “Failed” tab filters the log",
  lAfter.shown > 0 && lAfter.shown < lBefore.shown,
  `${lBefore.shown}/${lBefore.total} → ${lAfter.shown}/${lAfter.total}`,
);
// The search box is the half the broken script never reached, so demo.js owes it a response.
await open("exec-logs");
const logSearch = await evaluate(`(() => {
  const i = document.getElementById('logSearchInput');
  if (!i) return 'no such input';
  const rows = __demo.rowsNear(i) || [];
  i.value = 'zzqqxx'; i.dispatchEvent(new Event('input', { bubbles: true }));
  return { total: rows.length, shown: rows.filter(r => r.style.display !== 'none').length };
})()`);
check(
  "exec-logs: demo.js took over the search its dead script left unbound",
  logSearch.total > 1 && logSearch.shown === 0,
  JSON.stringify(logSearch),
);

await open("settings");
await click("Team & Permissions");
await sleep(250);
const st = await lastToast();
check("settings: a tab with no panel drawn says so", /only the .* panel is drawn/i.test(st), st);

/* ----------------------------------------------------------------- dropdowns built from data */
await open("contacts");
const cBefore = await ev("return rows();");
await click("Status: All");
await sleep(250);
const menu = await ev("return menus().length ? [...menus().slice(-1)[0].querySelectorAll('button')].map(b => b.textContent) : [];");
check("contacts: “Status: All” builds its menu from the column's own values", menu.length > 2, JSON.stringify(menu));
if (menu.length > 2) {
  await ev("[...menus().slice(-1)[0].querySelectorAll('button')][1].click(); return 1;");
  await sleep(250);
  const cAfter = await ev("return rows();");
  check(`contacts: choosing “${menu[1]}” filters the table`, cAfter > 0 && cAfter < cBefore, `${cBefore} → ${cAfter}`);
}

/* ------------------------------------------------------------------------ search as you type */
await open("attendance");
const rBefore = await ev("return rows();");
await ev(`const i = document.getElementById('roster-search'); i.value = 'a'; i.dispatchEvent(new Event('input', {bubbles:true})); return 1;`);
await sleep(200);
check("attendance: the export's own roster search still runs", rBefore > 1, `${rBefore} rows drawn`);

await open("whatsapp-hub");
check("whatsapp-hub loads with no JS error", errors.length === 0, errors[0]);
// This filter is the one that needed the "painted background wins" rule: it is red whether
// selected or not, so counting class strings could not find the selected tab. Assert both
// halves — that the selection moved onto it, and that the list below answered.
const needs = await ev(`const b = byLabel('Needs Reply (14)'); if (!b) return { missing: true };
  const seen = () => (__demo.rowsNear(b) || []).filter(r => r.style.display !== 'none').length;
  const was = b.className, before = seen();
  b.click();
  return { moved: b.className !== was, red: /error/.test(b.className), before, after: seen(),
           toast: toasts().slice(-1)[0] || '' };`);
check("whatsapp-hub: the dead “Needs Reply” filter now selects itself", needs.moved === true, JSON.stringify(needs));
check(
  "whatsapp-hub: and filters the list below, or says why it cannot",
  needs.after < needs.before || /sample data/i.test(needs.toast || ""),
  JSON.stringify(needs),
);

/* ---------------------------------------------------------------------------- canvas zoom */
await open("journey-builder");
await clickSel("[title='Zoom In']");
await clickSel("[title='Zoom In']");
await sleep(300);
const zoom = await evaluate(
  `(() => { const s = [...document.querySelectorAll('div')].find(d => d.dataset.demoZoom);
     const pct = [...document.querySelectorAll('span')].map(x => x.textContent.trim()).find(t => /^\\d{2,3}%$/.test(t));
     return { z: s && s.dataset.demoZoom, pct }; })()`,
);
check("journey-builder: Zoom In scales the canvas", !!zoom.z && parseFloat(zoom.z) > 1, JSON.stringify(zoom));
check("journey-builder: the zoom readout follows the canvas", zoom.pct === "120%", JSON.stringify(zoom));
await clickSel("[title='Fit Canvas to Viewport']");
await sleep(300);
check(
  "journey-builder: Fit returns it to 100%",
  (await evaluate(`(() => { const s = [...document.querySelectorAll('div')].find(d => d.dataset.demoZoom); return s && s.dataset.demoZoom; })()`)) === "1",
);

await open("journey-builder-spacious");
await clickSel("[title='Zoom Out']");
await sleep(300);
const sp = await evaluate(
  `(() => { const s = [...document.querySelectorAll('div')].find(d => d.dataset.demoZoom);
     return { z: s && s.dataset.demoZoom, palette: !!(s && s.contains(document.getElementById('flow-palette'))) }; })()`,
);
check("spacious canvas: Zoom Out scales the graph", !!sp.z && parseFloat(sp.z) < 1, JSON.stringify(sp));
check("spacious canvas: the step palette is left out of the zoom", sp.z && sp.palette === false, JSON.stringify(sp));
check("spacious canvas: its own tool switcher still works", (await clickSel("#tool-pan")) === "clicked");

/* ------------------------------------------------------------- undrawn nav items explain */
await open("flow-builder");
check("flow-builder loads with no JS error", errors.length === 0, errors[0]);
check("flow-builder: its sidebar reaches the three other Flow Engine screens", (await evaluate(`document.querySelectorAll('a[href$=".html"]:not(#demo-switcher a)').length`)) >= 3);
await clickSel("[data-demo-undrawn]");
await sleep(250);
const un = await lastToast();
check("flow-builder: an undrawn sidebar item explains itself", /sidebar item only/.test(un), un);
check("flow-builder: and does not navigate", (await where()) === "flow-builder.html", await where());

/* -------------------------------------------------------- controls that do the real thing
 * These are the checks that stop the demo drifting back into a wall of toasts. Each one
 * asserts the effect, not the announcement: a file's contents, a column really gone, a row
 * really added, the stepper really moved.
 */
await open("analytics");
await evaluate(`(() => { window.__blob = null; const real = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { window.__blob = b; return real(b); }; return 1; })()`);
const exp = await ev(`const b = byLabel('Export CSV / Report'); if (!b) return { missing: true };
  const visible = (__demo.rowsNear(b) || []).filter(r => r.style.display !== 'none').length;
  b.click(); return { visible, busy: lab(b) };`);
check("analytics: Export reads as busy while it works", /preparing/i.test(exp.busy || ""), JSON.stringify(exp));
await sleep(900); // busyRun does its work at the moment the label turns to "Downloaded"
const csv = await evaluate(`(async () => (window.__blob ? await window.__blob.text() : ''))()`);
const lines = csv ? csv.trim().split("\n") : [];
check(
  "analytics: Export builds a real CSV out of the table on the screen",
  lines.length === exp.visible + 1 && /,/.test(lines[0] || ""),
  JSON.stringify({ lines: lines.length, visible: exp.visible, head: lines[0] }),
);
check("analytics: and names the file it handed over", /\.csv/.test(await lastToast()), await lastToast());

const cols = await ev(`const b = byLabel('Columns'); if (!b) return { missing: true };
  b.click(); const m = menus().slice(-1)[0]; if (!m) return { noMenu: true };
  // Menu items carry a tick for a column that is currently shown, so the verb is not at the
  // start of the string.
  return { items: [...m.querySelectorAll('button')].map(x => x.textContent.replace(/^[^A-Za-z]+/, '')) };`);
check(
  "analytics: “Columns” offers the table's own headers",
  (cols.items || []).some((t) => /^Hide /.test(t)),
  JSON.stringify(cols),
);
const hid = await ev(`const m = menus().slice(-1)[0]; if (!m) return { noMenu: true };
  const item = [...m.querySelectorAll('button')].find(x => /Hide /.test(x.textContent));
  if (!item) return { noItem: true };
  const name = item.textContent.replace(/^[^A-Za-z]+/, '').replace(/^Hide /, ''); item.click();
  const th = [...document.querySelectorAll('thead th, thead td')].find(h => lab(h) === name);
  if (!th) return { name, noHeader: true };
  const i = [...th.parentElement.children].indexOf(th);
  return { name, th: th.style.display,
           cells: [...document.querySelectorAll('tbody tr')].map(r => r.children[i] && r.children[i].style.display) };`);
check(
  `analytics: hiding “${hid.name}” drops the header and every cell under it`,
  hid.th === "none" && (hid.cells || []).every((d) => d === "none"),
  JSON.stringify(hid),
);

/* The ⋮ at the end of every row: dead on every screen until now. */
await open("journeys");
const jBefore = await ev("return rows();");
const opts = await ev(`const r = [...document.querySelectorAll('tbody tr')][0];
  const b = [...r.querySelectorAll('button')].find(x => /more_vert|more_horiz/.test(x.textContent));
  if (!b) return { missing: true }; b.click();
  const m = menus().slice(-1)[0]; if (!m) return { noMenu: true };
  return { items: [...m.querySelectorAll('button')].map(x => x.textContent),
           chip: __demo.statusChip(r) ? lab(__demo.statusChip(r)) : null };`);
check(
  "journeys: a row's ⋮ opens a menu about that row",
  (opts.items || []).indexOf("Duplicate") >= 0,
  JSON.stringify(opts),
);
const flipped = await ev(`const m = menus().slice(-1)[0]; if (!m) return { noMenu: true };
  const item = [...m.querySelectorAll('button')].find(x => /^(Pause|Resume)$/.test(x.textContent));
  if (!item) return { noFlip: true }; const was = item.textContent; item.click();
  const r = [...document.querySelectorAll('tbody tr')][0];
  return { was, chip: lab(__demo.statusChip(r)) };`);
check(
  `journeys: “${flipped.was}” flips that row's own status chip`,
  /^(paused|active)$/i.test(flipped.chip || ""),
  JSON.stringify(flipped),
);
const dup = await ev(`const r = [...document.querySelectorAll('tbody tr')][0];
  [...r.querySelectorAll('button')].find(x => /more_vert|more_horiz/.test(x.textContent)).click();
  const m = menus().slice(-1)[0];
  [...m.querySelectorAll('button')].find(x => x.textContent === 'Duplicate').click();
  return { rows: rows(), copy: [...document.querySelectorAll('tbody tr')].some(r => /Copy of/.test(r.innerText)) };`);
check(
  "journeys: Duplicate really adds the row, named as a copy",
  dup.rows === jBefore + 1 && dup.copy === true,
  JSON.stringify({ before: jBefore, ...dup }),
);

/* The wizard. Stitch numbered four steps and drew the second, so the other three are authored
 * under panels/ and injected by wire.py; demo.js switches between them. These checks are what
 * keeps the stepper from going back to being a picture of a stepper. */
await open("modal-create-campaign");
const shown = `[...document.querySelectorAll('[data-demo-panel]')]
  .filter(p => p.style.display !== 'none').map(p => p.getAttribute('data-demo-panel'))`;
const own = `(document.querySelector('[data-demo-panels]').nextElementSibling.style.display || 'shown')`;
const nextBtn = `[...clickable()].find(x => /^next/i.test(lab(x)))`;
const backBtn = `[...clickable()].find(x => /^back\\b/i.test(lab(x)))`;
const wiz = await ev(`const st = __demo.stepper(); if (!st) return { noStepper: true };
  const ticks = () => st.steps.filter(s => s.querySelector('.material-symbols-outlined')).length;
  const before = ticks();
  const b = ${nextBtn};
  if (!b) return { noNext: true }; b.click();
  return { steps: st.steps.length, before, after: ticks(), toast: toasts().slice(-1)[0] || '',
           panels: document.querySelectorAll('[data-demo-panel]').length,
           at: __demo.wizardAt(), shown: ${shown}, own: ${own}, next: lab(${nextBtn}) };`);
check("campaign wizard: Next ticks off the step you were on", wiz.after === wiz.before + 1, JSON.stringify(wiz));
check("campaign wizard: and says which of the four steps it moved to", /step 3 of 4/i.test(wiz.toast || ""), wiz.toast);
check("campaign wizard: the three steps Stitch never drew are there", wiz.panels === 3, JSON.stringify(wiz));
check(
  "campaign wizard: Next shows step 3's panel and hides the export's own",
  wiz.at === 3 && String(wiz.shown) === "3" && wiz.own === "none",
  JSON.stringify(wiz),
);
check(
  "campaign wizard: the footer names the step it would move to next",
  /^next: schedule/i.test(wiz.next || ""),
  wiz.next,
);
/* A sample contact renders the template with that contact's own values. */
const prev = await ev(`const sample = [...document.querySelectorAll('[data-demo-panel="3"] button')]
    .filter(b => b.querySelector('[data-demo-value]'));
  const slots = () => [...document.querySelectorAll('[data-demo-panel="3"] [data-demo-slot]')].map(s => s.textContent);
  const before = slots();
  const row = sample.find(b => /no name on the registration/i.test(lab(b)));
  if (!row) return { missing: true }; row.click();
  return { rows: sample.length, before, after: slots(), toast: toasts().slice(-1)[0] || '',
           ring: /ring-2/.test(row.className) };`);
check(
  "campaign wizard: a sample contact renders the preview with its own values",
  prev.rows === 5 && String(prev.before) !== String(prev.after) && prev.after.indexOf("there") >= 0 && prev.ring,
  JSON.stringify(prev),
);
/* Step 4's Next is not a Next. */
const sendStep = await ev(`${nextBtn}.click();
  const b = [...clickable()].find(x => /^send broadcast/i.test(lab(x)));
  return { at: __demo.wizardAt(), shown: ${shown},
           send: b ? lab(b) : null, icon: b ? (b.querySelector('.material-symbols-outlined') || {}).textContent : null,
           marks: __demo.stepper().steps.map(s => lab(s).slice(0, 24)) };`);
check(
  "campaign wizard: the last step turns the footer into Send broadcast",
  sendStep.at === 4 && String(sendStep.shown) === "4" && sendStep.send === "Send broadcast" && sendStep.icon === "send",
  JSON.stringify(sendStep),
);
/* Back walks the same steps in reverse, and only stops being a step at step one. */
const wizBack = await ev(`${backBtn}.click(); ${backBtn}.click();
  return { at: __demo.wizardAt(), shown: ${shown}, own: ${own} };`);
check(
  "campaign wizard: Back walks back to the step Stitch drew",
  wizBack.at === 2 && String(wizBack.shown) === "" && wizBack.own === "shown",
  JSON.stringify(wizBack),
);
/* Choosing an audience swaps the block that asks for its detail. */
const reveal = await ev(`const p = document.querySelector('[data-demo-panel="1"]');
  ${backBtn}.click();
  const shownWhen = () => [...p.querySelectorAll('[data-demo-shown-when]')]
    .filter(x => x.style.display !== 'none').map(x => x.getAttribute('data-demo-shown-when'));
  const before = shownWhen();
  const b = p.querySelector('[data-demo-reveals="upload"]'); if (!b) return { missing: true };
  b.click();
  return { at: __demo.wizardAt(), before, after: shownWhen(), toast: toasts().slice(-1)[0] || '' };`);
check(
  "campaign wizard: picking an audience reveals what that audience needs",
  reveal.at === 1 && String(reveal.before) === "webinar" && String(reveal.after) === "upload",
  JSON.stringify(reveal),
);

/* The hub's composer: pills fill it, Send puts a bubble in the thread. */
await open("whatsapp-hub");
const pill = await ev(`const b = [...clickable()].find(x => /^\\[.+\\]$/.test(lab(x)));
  if (!b) return { missing: true };
  const text = lab(b).replace(/^\\[|\\]$/g, ''); b.click();
  const i = [...document.querySelectorAll('input')].find(f => /repl|type a/i.test(f.placeholder || ''));
  return { text, value: i ? i.value : null };`);
check(
  "hub: a quick-reply pill drops its text into the composer",
  pill.value && pill.value.indexOf(pill.text) >= 0,
  JSON.stringify(pill),
);
const sent = await ev(`const bubbles = () => document.querySelectorAll("[class*='items-end']").length;
  const before = bubbles(); const b = byLabel('Send'); if (!b) return { missing: true }; b.click();
  const i = [...document.querySelectorAll('input')].find(f => /repl|type a/i.test(f.placeholder || ''));
  return { before, after: bubbles(), left: i.value, toast: toasts().slice(-1)[0] || '' };`);
check(
  "hub: Send adds the reply to the thread and empties the box",
  sent.after === sent.before + 1 && sent.left === "",
  JSON.stringify(sent),
);
const copied = await ev(`const b = [...clickable()].find(x => /content_copy/.test(x.textContent));
  if (!b) return { missing: true }; b.click();
  return { label: lab(b), toast: toasts().slice(-1)[0] || '' };`);
check("hub: Copy copies the value beside it", /^copied/i.test(copied.toast || ""), JSON.stringify(copied));

/* A retry that produces an attempt. exec-logs draws its log as cards, not a table, so this
 * asks demo.js what it considers the rows — the same answer the handler acted on. */
await open("exec-logs");
const logBefore = await ev(`const b = byLabel('Resend Message'); if (!b) return { missing: true };
  b.dataset.probe = '1'; const rs = __demo.rowsNear(b) || [];
  return { count: rs.length, first: lab(rs[0] || document.body).slice(0, 40) };`);
await clickSel("[data-probe]");
await sleep(900);
const resent = await ev(`const b = document.querySelector('[data-probe]');
  const rs = __demo.rowsNear(b) || [];
  return { count: rs.length, top: rs[0] && __demo.statusChip(rs[0]) ? lab(__demo.statusChip(rs[0])) : null,
           toast: toasts().slice(-1)[0] || '' };`);
check(
  "exec-logs: Resend puts a fresh queued attempt at the top of the log",
  resent.count === logBefore.count + 1 && /queued/i.test(resent.top || ""),
  JSON.stringify({ before: logBefore, ...resent }),
);

/* Connect: the card's status flips, and the button keeps the opposite verb. */
await open("integrations");
const conn = await ev(`const b = [...clickable()].find(x => /^connect$/i.test(lab(x)));
  if (!b) return { missing: true }; b.dataset.probe = '1'; b.click(); return { was: lab(b) };`);
await sleep(2500); // busy (520ms) → done → resting label (1600ms later)
const conn2 = await ev(`const b = document.querySelector('[data-probe]'); if (!b) return { missing: true };
  const card = b.closest("div[class*='rounded-']");
  return { label: lab(b), card: card ? lab(card).slice(0, 90) : null };`);
check(
  "integrations: Connect leaves the card connected and the button offering Disconnect",
  /^disconnect/i.test(conn2.label || ""),
  JSON.stringify({ ...conn, ...conn2 }),
);

/* Add Keyword: this row has no input, so the new chip is the input. */
await open("settings");
const kw = await ev(`const b = byLabel('Add Keyword'); if (!b) return { missing: true };
  b.click();
  const fresh = [...document.querySelectorAll('[contenteditable=true]')].slice(-1)[0];
  if (!fresh) return { noSlot: true };
  const chips = [...fresh.parentElement.children].length;
  fresh.textContent = 'CANCELME';
  fresh.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return { chips, hit: [...document.querySelectorAll('span')].some(e => lab(e) === 'CANCELME'),
           settled: fresh.getAttribute('contenteditable'), toast: toasts().slice(-1)[0] || '' };`);
check(
  "settings: Add Keyword opens an empty chip to type the keyword into",
  kw.hit === true && kw.settled === "false" && /added to the list/i.test(kw.toast || ""),
  JSON.stringify(kw),
);

/* And the toolbar button that used to answer "only the Discard panel is drawn". */
const save = await ev(`const b = byLabel('Save Changes'); if (!b) return { missing: true };
  b.dataset.probe = '1'; b.click(); return { busy: lab(b) };`);
check("settings: “Save Changes” goes busy rather than mistaking itself for a tab", /saving/i.test(save.busy || ""), JSON.stringify(save));
await sleep(800);
const saved = await ev(`const b = document.querySelector('[data-probe]');
  return { label: lab(b), toast: toasts().slice(-1)[0] || '' };`);
check(
  "settings: then reads Saved, and still admits nothing is stored",
  /^saved$/i.test(saved.label || "") && /mockup/i.test(saved.toast || ""),
  JSON.stringify(saved),
);

/* ------------------------------------------------------- the chrome that was dead on every screen
 * The bell and the help icon are drawn on all fourteen Engage screens, and until now both
 * only toasted. The bell's panel is built out of the screen it is on, which is what these
 * assert: the items name rows that are really there, and the unread dot goes out.
 */
await open("dashboard");
const bell = await ev(`const b = [...clickable()].find(x => /notification/i.test(x.title || ''));
  if (!b) return { missing: true };
  const dot = [...b.children].find(c => !c.children.length && !c.textContent.trim());
  b.click();
  const menu = menus()[0];
  const items = menu ? [...menu.querySelectorAll('button')].map(i => lab(i)) : [];
  return { items, dotHidden: dot ? dot.style.display === 'none' : null,
           onPage: items.filter(i => i && document.body.innerText.includes(i.split(' · ')[1] || 'nope')).length };`);
check(
  "dashboard: the bell opens a panel built from what the screen itself timestamps",
  bell.items && bell.items.length > 2 && bell.items.some((i) => /\d+\s?[mhd].*·/.test(i)),
  JSON.stringify(bell),
);
check("dashboard: and clears its unread dot", bell.dotHidden === true, JSON.stringify(bell));
const helpMenu = await ev(`const b = [...document.querySelectorAll('a, button')]
    .find(x => /help|documentation/i.test(x.title || '') && !x.closest('#demo-switcher'));
  if (!b) return { missing: true }; b.click();
  const menu = menus()[0];
  return { items: menu ? [...menu.querySelectorAll('button')].map(i => lab(i)) : [] };`);
check(
  "dashboard: help points at the mockup's own documentation",
  (helpMenu.items || []).some((i) => /wired in this mockup/i.test(i)),
  JSON.stringify(helpMenu),
);

/* ------------------------------------------------------------------ the canvases can be edited
 * A + on a connector and a delete in the header were the two deadest controls in the set: a
 * journey builder whose only working control is the zoom is not a journey builder.
 */
await open("journey-builder-spacious");
const ins = await ev(`const b = [...clickable()].find(x => /insert step/i.test(x.title || ''));
  if (!b) return { missing: true };
  const slot = b.parentElement, col = slot.parentElement;
  const before = col.children.length;
  b.click();
  const fresh = document.querySelector('[data-demo-new-step]');
  return { before, after: col.children.length, fresh: fresh ? lab(fresh).slice(0, 40) : null,
           placed: fresh ? fresh.previousElementSibling === slot : null };`);
check(
  "spacious canvas: the + on a connector really puts a step in the gap",
  ins.after === ins.before + 1 && /New Step/.test(ins.fresh || "") && ins.placed === true,
  JSON.stringify(ins),
);
const side = await ev(`const b = [...clickable()].find(x => /sidebar|canvas width/i.test(x.title || ''));
  if (!b) return { missing: true };
  const aside = document.querySelector('aside');
  b.click();
  const gone = getComputedStyle(aside).display === 'none';
  const pulled = [...document.querySelectorAll('[data-demo-inset]')].map(n => n.dataset.demoInset);
  b.click();
  return { gone, pulled, back: getComputedStyle(aside).display !== 'none',
           restored: document.querySelectorAll('[data-demo-inset]').length };`);
check(
  "spacious canvas: the sidebar toggle hides the shell and frees the column beside it",
  side.gone === true && (side.pulled || []).length > 0,
  JSON.stringify(side),
);
check(
  "spacious canvas: and the second click puts back exactly what the first took away",
  side.back === true && side.restored === 0,
  JSON.stringify(side),
);

await open("step-branch-rules");
const del = await ev(`const b = document.querySelector('[title*="Delete Step"]');
  if (!b) return { missing: true }; b.click(); return { clicked: true };`);
check("step-branch-rules: Delete Step Node exists", del.clicked === true, JSON.stringify(del));
await sleep(400);
check(
  "step-branch-rules: deleting the step leaves for the canvas it was on",
  (await where()) !== "step-branch-rules.html",
  await where(),
);

/* ------------------------------------------------------------------------- choosing a thing
 * Five trigger cards in the create-journey modal, and none of them could be chosen.
 */
await open("modal-create-journey");
const card = await ev(`const b = [...clickable()].find(x => /Stream Concluded/.test(x.textContent));
  if (!b) return { missing: true };
  const was = b.className, sibs = [...b.parentElement.children].length;
  b.click();
  return { sibs, chosen: b.hasAttribute('data-demo-chosen') || b.className !== was,
           ring: b.style.boxShadow, toast: toasts().slice(-1)[0] || '' };`);
check(
  "create-journey: a trigger card can be chosen, and looks chosen",
  card.chosen === true && /chosen/i.test(card.toast || ""),
  JSON.stringify(card),
);
const jump = await ev(`const b = byLabel('Choose Trigger Event (Custom)');
  if (!b) return { missing: true };
  // Going to a section is a scroll, and a scroll leaves no trace in the DOM — so the only way
  // to assert it is to be the one who answers scrollIntoView.
  let scrolled = null;
  const sv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () { scrolled = lab(this).slice(0, 40); return sv.apply(this, arguments); };
  b.click();
  Element.prototype.scrollIntoView = sv;
  return { scrolled, toast: toasts().slice(-1)[0] || '' };`);
check(
  "create-journey: the mode strip goes to the section it names",
  /custom trigger/i.test(jump.scrolled || "") && /section/i.test(jump.toast || ""),
  JSON.stringify(jump),
);

/* -------------------------------------------------------------- the hub's remaining controls */
await open("whatsapp-hub");
const res = await ev(`const b = document.querySelector('[title="Mark as Resolved"]');
  if (!b) return { missing: true };
  const chips = () => [...document.querySelectorAll('span')].filter(s => /^Needs Reply$/i.test(lab(s))).length;
  const before = chips();
  b.click();
  return { before, after: chips(), toast: toasts().slice(-1)[0] || '' };`);
check(
  "hub: Mark as Resolved flips the chip on that chat's own card in the list",
  res.after === res.before - 1 && /resolved/i.test(res.toast || ""),
  JSON.stringify(res),
);
const att = await ev(`const b = document.querySelector('[title="Attach Template"]');
  if (!b) return { missing: true };
  b.click();
  const menu = menus()[0];
  const items = menu ? [...menu.querySelectorAll('button')] : [];
  if (!items.length) return { noMenu: true };
  items[0].click();
  const box = [...document.querySelectorAll('input')].find(i => /type a reply/i.test(i.placeholder || ''));
  return { offered: items.map(i => lab(i)), filled: box ? box.value : null };`);
check(
  "hub: the paperclip offers the canned replies that are drawn on this screen",
  (att.offered || []).length > 1 && !!att.filled && att.offered[0] === att.filled,
  JSON.stringify(att),
);

/* --------------------------------------------------------- the rest of the toast-only clicks */
await open("templates");
const tok = await ev(`const b = [...clickable()].find(x => lab(x) === '+ Add {{first_name}}');
  if (!b) return { missing: true };
  const body = [...document.querySelectorAll('p')].filter(p => lab(p).length > 12).slice(-1)[0];
  const was = body ? lab(body) : null;
  b.click();
  return { was, now: body ? lab(body) : null, toast: toasts().slice(-1)[0] || '' };`);
check(
  "templates: a variable chip really goes into the message the preview draws",
  /\{\{first_name\}\}$/.test(tok.now || "") && tok.now !== tok.was,
  JSON.stringify(tok),
);

/* attendance has no table: its roster is cards, so this is the export reading rowsNear. */
await open("attendance");
const roster = await evAsync(`const b = byLabel('CSV Export'); if (!b) return { missing: true };
  let grabbed = null;
  const mk = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => { grabbed = blob; return mk(blob); };
  b.click();
  await new Promise(r => setTimeout(r, 900));
  const text = grabbed ? await grabbed.text() : '';
  return { lines: text.trim().split(String.fromCharCode(10)).length, head: text.slice(0, 60),
           toast: toasts().slice(-1)[0] || '' };`);
check(
  "attendance: “CSV Export” exports the cohort cards, table or no table",
  roster.lines > 1 && /\.csv/.test(roster.toast || ""),
  JSON.stringify(roster),
);

/* ----------------------------------------------------------------------------- the sweep
 * Click every button on every screen, one at a time, reloading whenever a click navigated.
 * A button is "mute" if the click did nothing a user could perceive.
 *
 * "Nothing" has to be defined generously or the sweep cries wolf: a DOM mutation is the
 * main signal, but database-webhooks' Export SQL DDL Schema only builds a Blob and clicks
 * an object URL, and its Test Webhook Endpoint only smooth-scrolls — both are wired, and
 * neither touches the DOM. Rather than wait 150ms per click for a scroll event to land
 * (a minute of wall clock over 350-odd buttons), the three side effects that leave no
 * markup behind are counted at the source: scrollIntoView, scrollTo and createObjectURL
 * are patched once per page to bump a counter, so the whole oracle stays synchronous and
 * one round trip does a button. */
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""));
console.log("\nsweep — every button on every screen:");
let muteTotal = 0,
  talkTotal = 0,
  clicked = 0,
  demoErrorScreens = 0;
const exportFaults = [];
const leaks = [];
for (const slug of ALL) {
  await open(slug);
  // Authored markup carries a comment explaining itself, and a nested `<!--` inside it ends
  // the comment early and spills the rest of the explanation across the top of the screen —
  // which is exactly what happened once. A screen must never read out its own plumbing.
  const leak = await evaluate(
    `(document.body.innerText.match(/wire\\.py|demo\\.js|data-demo-[a-z]+|tailwind\\.config/) || [''])[0]`,
  );
  if (leak) leaks.push(`${slug}: ${leak}`);
  const total = await ev("return clickable().length;");
  const mute = [];
  const idle = [];
  const talk = [];
  let navigated = 0,
    disabled = 0;
  const seen = [];
  for (let i = 0; i < total; i++) {
    let r;
    navSeen = false;
    try {
      r = await ev(`const b = clickable()[${i}]; if (!b) return null;
        const label = lab(b).slice(0, 38) || '(icon: ' + (b.title || '?') + ')';
        // A disabled button is not mute: the browser refuses the click, and looking
        // unclickable is the response. Clicking it would dispatch nothing anyway.
        if (b.disabled) return { label, disabled: true };
        if (window.__side === undefined) {
          window.__side = 0;
          const mk = URL.createObjectURL.bind(URL), sv = Element.prototype.scrollIntoView, to = window.scrollTo;
          URL.createObjectURL = x => { window.__side++; return mk(x); };
          Element.prototype.scrollIntoView = function () { window.__side++; return sv.apply(this, arguments); };
          window.scrollTo = function () { window.__side++; return to.apply(window, arguments); };
        }
        // A mutation inside the demo's own furniture is not the screen answering. The toast
        // deck and the menus are the only fixed z-index-10000 children of <body>, which is
        // how a toast is told apart from a control that actually moved something.
        const furniture = n => { for (let e = n && (n.nodeType === 1 ? n : n.parentElement); e; e = e.parentElement) {
            if (e.id === 'demo-switcher') return true;
            if (e.parentElement === document.body && e.style.zIndex === '10000') return true;
          } return false; };
        let seen = 0, real = 0;
        const obs = new MutationObserver(() => {});
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        // Filling a field is the one real effect a MutationObserver cannot see: value is a
        // property, not an attribute, so the composer and every search box would be scored as
        // having done nothing. Snapshot them instead.
        const fields = () => [...document.querySelectorAll('input, textarea')].map(f => f.value).join('\u0001');
        const f0 = fields();
        const t0 = toasts().length, m0 = menus().length, s0 = window.__side;
        b.click();
        for (const rec of obs.takeRecords()) { seen++; if (!furniture(rec.target)) real++; }
        obs.disconnect();
        if (fields() !== f0) real++;
        const side = window.__side !== s0, menu = menus().length !== m0, spoke = toasts().length !== t0;
        return { label, owned: __demo.isOwned(b),
                 quiet: seen === 0 && !side && !spoke && !menu,
                 // Answered, but only in words: nothing on the screen itself moved.
                 talk: real === 0 && !side && !menu && spoke };`);
      if (!r) break;
      if (r.disabled) {
        disabled++;
        continue;
      }
      clicked++;
      await sleep(15); // long enough for a requested navigation to be reported
    } catch (e) {
      // The click navigated away mid-command; treat it as a navigation and reload.
      navigated++;
      await open(slug);
      continue;
    }
    if (navSeen) {
      navigated++;
      await open(slug);
      continue;
    }
    if (r.talk && !talk.includes(r.label)) talk.push(r.label);
    if (r.quiet && !seen.includes(r.label)) {
      seen.push(r.label);
      // Quiet on a control the export's own script listens to is not a dead click: clicking
      // a contact's chevron re-selects a row that is already selected, and the export
      // rightly renders the same thing again. demo.js stays out of those by design, so
      // they are listed rather than counted against "no click is silently dead".
      (r.owned ? idle : mute).push(r.label);
    }
  }
  // Attribute errors by stack. demo.js throwing is this repo's bug and fails the run; an
  // export throwing inside its own inline script is Stitch's, and is reported as a fact
  // about the screen — demo.js is expected to cope with it, not to fix it.
  const bad = errors.filter((e) => !/favicon|ERR_FILE|net::/.test(e));
  const ours = bad.filter((e) => /demo\.js/.test(e));
  if (ours.length) demoErrorScreens++;
  const theirs = bad.filter((e) => !/demo\.js/.test(e));
  if (theirs.length) exportFaults.push(`${slug}: ${theirs[0].replace(/\s+/g, " ").slice(0, 120)}`);
  muteTotal += mute.length;
  talkTotal += talk.length;
  console.log(
    `  ${slug.padEnd(26)} ${String(total).padStart(3)} buttons, ${String(navigated).padStart(2)} navigate` +
      (disabled ? `, ${disabled} disabled` : "") +
      (talk.length ? `, ${talk.length} answer in words only` : "") +
      (ours.length ? `  demo.js ERROR: ${ours[0].slice(0, 90)}` : "") +
      (theirs.length ? `  export's own JS error` : "") +
      (idle.length ? `  idle (the export's own, idempotent): ${idle.slice(0, 4).join(" · ")}` : "") +
      (mute.length ? `  MUTE: ${mute.slice(0, 8).join(" · ")}` : "") +
      // TALK=1 names them. The point of counting the toast-only clicks is to be able to go
      // and look at them, and decide one by one whether a toast is the honest answer.
      (process.env.TALK && talk.length ? `\n${" ".repeat(29)}words only: ${talk.join(" · ")}` : ""),
  );
}
check("sweep: no screen prints the demo's own plumbing as prose", leaks.length === 0, leaks.join(" · "));
check(`sweep: ${clicked} clicks raised no error inside demo.js`, demoErrorScreens === 0, `${demoErrorScreens} screens threw`);
check(`sweep: every button gave some response`, muteTotal === 0, `${muteTotal} mute buttons`);
// The other half of the complaint this sweep answers: not "did it respond" but "did anything
// happen". A toast is the right answer for a control whose screen was never drawn, and the
// wrong one for a control that could have moved something, so the share is reported and held
// rather than left to drift back up.
check(
  `sweep: ${clicked - talkTotal} of ${clicked} clicks change the screen, not just talk about it`,
  talkTotal * 2 < clicked,
  `${talkTotal} answer in words only`,
);
if (exportFaults.length) {
  console.log("\nthe exports' own bugs, coped with rather than patched:");
  exportFaults.forEach((f) => console.log(`  - ${f}`));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
failures.forEach((f) => console.log(`  - ${f}`));
ws.close();
chrome.kill();
process.exit(failures.length ? 1 : 0);

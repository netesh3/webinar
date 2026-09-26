/* What the participant link actually renders, in a real browser, against the live deployment.
 *
 * The API-level probe (api/probe-live.sh) proves the server stores an E.164 number and refuses
 * an early join. Neither of those says the form has a country-code picker, or that somebody who
 * has just registered is offered a way in. Those are pixels, and the only honest way to check
 * pixels is to load the page.
 *
 * What it asserts, all on the PUBLIC url:
 *   1. a dial-code control exists, is populated, and starts on a country rather than blank
 *   2. the phone input is type=tel and is required
 *   3. after a successful registration the confirmation offers a join affordance — a live
 *      button when the doors are open, a countdown when they are not
 *   4. no host navigation appears anywhere on the participant journey
 *
 * Takes the webinar slug and the door state from argv, because creating a webinar needs a host
 * session and that already has a home in the shell probe. Usage:
 *
 *   node e2e/probe-register.mjs <slug> open|closed
 *
 * Raw CDP over one websocket, the same shape as probe-low-light.mjs: no test-runner dependency to
 * install on a machine that is only ever going to run this by hand.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "https://3.82.201.244.sslip.io";
const SLUG = process.argv[2];
const DOORS = process.argv[3] ?? "closed";
if (!SLUG) {
  console.error("usage: node e2e/probe-register.mjs <slug> open|closed");
  process.exit(2);
}

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "regchrome-"));
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

const CDP = 9560 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // The instance serves a certificate for an sslip.io name; trusting it here is the
    // point of the probe, not a hole in it.
    "--ignore-certificate-errors",
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
const consoleErrors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails.text ?? "exception");
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
  await sleep(1500);
}

await call("Runtime.enable");
await call("Page.enable");

const url = `${BASE}/webinars/${SLUG}`;
console.log(`\n== ${url}  (doors ${DOORS})`);
await goto(url);

const title = await evaluate("document.title");
console.log(`  page title: ${title}`);

/* ---------------------------------------------------------------- 1. the picker */
const dial = await evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s =>
    /\\+\\d/.test(s.textContent ?? ''));
  if (!sel) return null;
  return {
    options: sel.options.length,
    value: sel.value,
    selectedLabel: sel.options[sel.selectedIndex]?.textContent ?? '',
    hasIndia: [...sel.options].some(o => /\\+91\\b/.test(o.textContent)),
    hasUS: [...sel.options].some(o => /\\+1\\b/.test(o.textContent)),
  };
})()`);
if (!dial) bad("no dial-code select on the page");
else {
  dial.options >= 150 ? ok(`dial select has ${dial.options} countries`)
                      : bad(`dial select has only ${dial.options} options`);
  dial.value ? ok(`starts on ${dial.value} — ${dial.selectedLabel.trim()}`)
             : bad("dial select starts blank");
  dial.hasIndia && dial.hasUS ? ok("+91 and +1 both present")
                              : bad(`missing codes: india=${dial.hasIndia} us=${dial.hasUS}`);
}

const tel = await evaluate(`(() => {
  const el = document.querySelector('input[type=tel]');
  if (!el) return null;
  return { required: el.required, name: el.name || el.id || '', placeholder: el.placeholder };
})()`);
if (!tel) bad("no input[type=tel] — the number field is not a phone field");
else {
  ok(`phone input present (${tel.name || "unnamed"}) placeholder ${JSON.stringify(tel.placeholder)}`);
  tel.required ? ok("phone input is required") : bad("phone input is not marked required");
}

/* ---------------------------------------------------------------- 2. no host chrome */
const hostWords = [
  "Browse webinars", "My webinars", "Schedule", "Registrants", "Start webinar",
  "Host/Panelist", "Webinar ID", "Recordings", "Settings",
];
const leaks = await evaluate(`(() => {
  const text = document.body.innerText;
  const links = [...document.querySelectorAll('a')].map(a => (a.textContent||'').trim());
  const words = ${JSON.stringify(hostWords)};
  return {
    inText: words.filter(w => text.toLowerCase().includes(w.toLowerCase())),
    hostLinks: links.filter(t => words.some(w => t.toLowerCase() === w.toLowerCase())),
    allLinks: links.filter(Boolean).slice(0, 12),
  };
})()`);
console.log(`  links on the page: ${JSON.stringify(leaks.allLinks)}`);
leaks.inText.length === 0
  ? ok("no host vocabulary in the participant page")
  : bad(`host vocabulary present: ${leaks.inText.join(", ")}`);

/* ---------------------------------------------------------------- 3. register */
const stamp = Date.now();
const email = `probe-ui-${stamp}@example.invalid`;
const filled = await evaluate(`(async () => {
  const set = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const byLabel = (re) => [...document.querySelectorAll('input')].find(i => {
    const lab = i.labels?.[0]?.textContent ?? i.placeholder ?? '';
    return re.test(lab);
  });
  const first = byLabel(/first/i), last = byLabel(/last/i);
  const mail = document.querySelector('input[type=email]');
  const tel = document.querySelector('input[type=tel]');
  if (!first || !mail || !tel) return { error: 'form fields not found' };
  set(first, 'Probe'); if (last) set(last, 'Participant');
  set(mail, ${JSON.stringify(email)});
  set(tel, '9876543210');
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    if (!box.checked) box.click();
  }
  return { first: first.value, mail: mail.value, tel: tel.value };
})()`);
if (filled?.error) { bad(filled.error); }
else ok(`form filled (${filled.mail})`);

const submitted = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b =>
    /register|reserve|sign up|save my seat/i.test(b.textContent ?? '') && !b.disabled);
  if (!btn) return { error: 'no enabled submit button: ' +
    [...document.querySelectorAll('button')].map(b => b.textContent.trim() + (b.disabled?'(disabled)':'')).join(' | ') };
  btn.click();
  return { clicked: btn.textContent.trim() };
})()`);
if (submitted?.error) bad(submitted.error);
else ok(`clicked ${JSON.stringify(submitted.clicked)}`);

// The POST plus a re-render. Polled rather than slept on, so a slow round trip does not
// read as a missing button.
let after = null;
for (let i = 0; i < 30; i++) {
  await sleep(700);
  after = await evaluate(`(() => {
    const text = document.body.innerText;
    const buttons = [...document.querySelectorAll('button,a')]
      .map(b => ({ label: (b.textContent||'').trim(), disabled: !!b.disabled, tag: b.tagName }))
      .filter(b => b.label);
    return {
      text: text.slice(0, 2600),
      buttons,
      join: buttons.find(b => /^join/i.test(b.label)) ?? null,
      registered: /you'?re (registered|in)|see you|confirmed|registration confirmed/i.test(text),
      error: /something went wrong|could not|failed/i.test(text),
    };
  })()`);
  if (after?.registered || after?.join || after?.error) break;
}

console.log("\n  --- after submit ---");
console.log(after.text.split("\n").filter(Boolean).slice(0, 30).map((l) => "   | " + l).join("\n"));
console.log(`  buttons: ${JSON.stringify(after.buttons.map((b) => b.label + (b.disabled ? " (disabled)" : "")))}`);

after.error ? bad("the confirmation shows an error") : ok("no error on the confirmation");
after.registered ? ok("registration confirmed on screen") : bad("no confirmation text");

if (DOORS === "open") {
  after.join && !after.join.disabled
    ? ok(`live join affordance: ${JSON.stringify(after.join.label)}`)
    : bad(`no enabled Join control: ${JSON.stringify(after.join)}`);
} else {
  /* Doors shut: the correct answer is NOT a join button. It is a countdown that says when,
   * because a button that refuses is worse than no button.
   *
   * Matched on the gate's own heading and on a countdown value beneath it, not on "a number
   * followed by a unit" — that pattern also matches the "45 min" duration in the summary
   * above, so the first version of this check passed on a page with no gate at all. */
  const heading = /doors open in/i.test(after.text);
  const value = /doors open in\s*\n?\s*(\d+\s*(sec|min|hrs?|hours?|days?)\b)/i.exec(after.text);
  heading ? ok("the gate names when the doors open") : bad("no 'Doors open in' gate");
  value ? ok(`countdown reads ${JSON.stringify(value[1].replace(/\s+/g, " "))}`)
        : bad("the gate shows no countdown value");
  if (after.join && !after.join.disabled) {
    bad(`an enabled Join control is offered ${DOORS === "open" ? "" : "before the doors open"}: ${after.join.label}`);
  } else {
    ok("no enabled Join control before the doors open");
  }
}

const leaksAfter = await evaluate(`(() => {
  const text = document.body.innerText.toLowerCase();
  return ${JSON.stringify(hostWords)}.filter(w => text.includes(w.toLowerCase()));
})()`);
leaksAfter.length === 0
  ? ok("no host vocabulary on the confirmation either")
  : bad(`host vocabulary after registering: ${leaksAfter.join(", ")}`);

if (consoleErrors.length) console.log(`  page exceptions: ${consoleErrors.slice(0, 3).join(" / ")}`);

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
console.log(`registered ${email} — delete it with the registrant cleanup step`);
cleanup(fails === 0 ? 0 : 1);

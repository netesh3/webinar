/* Render each screen into shots/ — the contact sheet's thumbnails.
 *
 * Stitch ships a screenshot per screen, but for the Sep 2026 revision several came back
 * with the main table area blank (Contacts, Journeys) even though the markup was complete.
 * Rendering locally is both a better contact sheet and a check that every file displays.
 *
 * Width is fixed so every thumbnail crops to the same shape. Height is MEASURED, not taken
 * from the manifest: a Stitch design height is the canvas the screen was drawn on, not the
 * height its markup occupies, and the two disagree wildly — exec-logs is drawn on 2948px
 * (1843px at this width) and renders 980px. Shooting at the design height gave every
 * thumbnail a different slab of empty page below the content, which is what made the
 * contact sheet look ragged. So: lay the page out, ask it how tall it actually is, then
 * shoot exactly that.
 *
 * Replaces an earlier render.py. That spawned Chrome once per screen, which is the one
 * thing a measure-then-shoot pass cannot afford to do twice; this drives a single browser
 * over the DevTools protocol with Node's own WebSocket and no dependencies, the same way
 * verify.mjs does.
 *
 * Needs the network: the screens pull Tailwind and Inter from a CDN.
 *
 *   node scripts/render.mjs
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const WIDTH = 1600;
// Every screen's root is `min-h-screen`, so a page can never measure shorter than the
// window it is measured in — probe in a deliberately short one to learn the content's own
// height, then shoot at no less than a normal window, so a compact screen still looks like
// a screen rather than a letterbox.
const PROBE = 560;
const MIN = 900;
const MAX = 4000; // a screen taller than this is a scroll, not a thumbnail

const manifest = JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"));
mkdirSync(`${OUT}/shots`, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  `--remote-debugging-port=${PORT}`,
  "--remote-allow-origins=*",
  "--user-data-dir=/tmp/engage-render-profile",
  "about:blank",
]);
chrome.stderr.on("data", () => {});

let version;
for (let i = 0; i < 80; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
if (!version) {
  console.error("Chrome never came up on the debugging port.");
  process.exit(1);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let seq = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const w = m.id && waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
};
const send = (method, params = {}, sessionId) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), rej(new Error("timeout: " + method))), 30000);
  });
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const resize = (height) =>
  send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 1, mobile: false }, sessionId);

/* How tall the markup is once it has settled. `document.fonts.ready` matters more than it
 * looks: Inter arriving late reflows every line box, and a shot taken before it lands is
 * both the wrong height and the wrong typeface. */
const measure = () =>
  ev(`(async () => {
    await document.fonts.ready;
    // The switcher is the demo's own furniture and has no business in a thumbnail. Removing
    // it here rather than relying on render running before wire.py: an ordering rule that is
    // only documented is an ordering rule that gets broken.
    document.querySelectorAll('#demo-switcher').forEach(el => el.remove());
    const de = document.documentElement, b = document.body;
    return { height: Math.max(de.scrollHeight, Math.round(b.getBoundingClientRect().height)),
             sideways: de.scrollWidth - de.clientWidth };
  })()`);

console.log(`screen                       shot        design       sideways`);
let sideways = 0;
for (const m of manifest) {
  await resize(PROBE);
  await send("Page.navigate", { url: `file://${OUT}/screens/${m.slug}.html` }, sessionId);
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    if ((await ev("document.readyState")) === "complete") break;
  }
  await sleep(250); // the CDN stylesheet applies a frame or two after readyState

  // Measure, resize to that, measure again: an `h-screen` sidebar or a `min-h-screen`
  // column grows with the viewport, so the first answer is only an estimate and a tall
  // screen needs a round or two to settle.
  let height = PROBE;
  let probe;
  for (let pass = 0; pass < 4; pass++) {
    probe = await measure();
    const next = Math.min(MAX, Math.max(MIN, probe.height));
    if (next === height) break;
    height = next;
    await resize(height);
    await sleep(120);
  }

  const shot = await send(
    "Page.captureScreenshot",
    // Clipped to the viewport width on purpose: a screen that scrolls sideways is a defect
    // to report, not extra canvas to photograph.
    { format: "png", clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 }, captureBeyondViewport: true },
    sessionId,
  );
  const png = Buffer.from(shot.data, "base64");
  writeFileSync(`${OUT}/shots/${m.slug}.png`, png);

  const design = `${Math.round((m.height * WIDTH) / m.width)}px`;
  const side = probe.sideways > 0 ? `← scrolls ${probe.sideways}px` : "";
  if (probe.sideways > 0) sideways++;
  const thin = png.length < 20000 ? "  ← suspiciously empty" : "";
  console.log(
    `${m.slug.padEnd(28)} ${String(WIDTH + "x" + height).padEnd(11)} ${design.padEnd(12)} ${side}${thin}`,
  );
}

if (sideways) console.log(`\n${sideways} screen(s) scroll horizontally at ${WIDTH}px — see README's wrinkles.`);
ws.close();
chrome.kill();

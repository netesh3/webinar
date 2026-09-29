/* Guided-tour recorder: drives the real app with Playwright, draws a visible
 * cursor, click ripples and subtitles on the page, narrates every line with
 * macOS `say`, and muxes the lot into one MP4 per tour with ffmpeg.
 *
 * A tour is a list of scenes. Each scene is one spoken line plus the actions
 * that happen while it is spoken; the scene lasts as long as the longer of
 * the two, so voice and screen never drift apart.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, "playwright"].filter(Boolean);
  const npx = join(process.env.HOME, ".npm/_npx");
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) tries.push(join(npx, d, "node_modules/playwright"));
  }
  for (const p of tries) {
    try {
      return require(p);
    } catch {}
  }
  throw new Error("playwright not found — `npm i -g playwright` or set PLAYWRIGHT_PATH");
}

export const { chromium } = loadPlaywright();

const W = 1440;
const H = 900;
const VOICE = process.env.TOUR_VOICE ?? "Samantha";
const RATE = process.env.TOUR_RATE ?? "182";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffprobeSeconds(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]).toString();
  return parseFloat(out);
}

/** One cached narration clip per distinct line. */
function speak(text, cacheDir) {
  const id = createHash("sha1").update(`${VOICE}|${RATE}|${text}`).digest("hex").slice(0, 16);
  const file = join(cacheDir, `${id}.aiff`);
  if (!existsSync(file)) execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", file, text]);
  return { file, seconds: ffprobeSeconds(file) };
}

/* Everything drawn on top of the app. Injected into every document so it
 * survives full reloads; state (cursor spot, subtitle) is re-applied by node. */
const OVERLAY = `(() => {
  if (window.__tour) return;
  const css = \`
    nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none!important}
    #tour-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;
      transition:transform .75s cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    #tour-ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #7c5cff;border-radius:12px;
      box-shadow:0 0 0 6px rgba(124,92,255,.18);opacity:0;transition:opacity .25s, all .35s ease}
    .tour-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;
      border-radius:50%;background:rgba(124,92,255,.55);animation:tour-rip .6s ease-out forwards}
    @keyframes tour-rip{to{transform:scale(4.5);opacity:0}}
    #tour-cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1040px;z-index:2147483647;
      pointer-events:none;background:rgba(17,17,28,.86);color:#fff;font:500 21px/1.45 -apple-system,system-ui,sans-serif;
      padding:12px 22px;border-radius:14px;text-align:center;opacity:0;transition:opacity .25s;backdrop-filter:blur(6px)}
    #tour-chip{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#7c5cff;color:#fff;
      font:600 12px/1 -apple-system,system-ui,sans-serif;padding:7px 11px;border-radius:999px;letter-spacing:.02em;opacity:.92}
    #tour-card{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;flex-direction:column;
      background:radial-gradient(1200px 700px at 30% 20%,#2a1f6b,#0e0c1d);color:#fff;font-family:-apple-system,system-ui,sans-serif;text-align:center}
    #tour-card .k{font:600 15px/1 inherit;letter-spacing:.18em;text-transform:uppercase;color:#b9a8ff;margin-bottom:22px}
    #tour-card .t{font:700 58px/1.1 inherit;max-width:1100px}
    #tour-card .s{font:400 24px/1.4 inherit;color:#d6d0f5;margin-top:18px;max-width:900px}
    #tour-card .n{margin-top:40px;font:500 14px/1 inherit;color:#8f86b8}\`;
  const add = () => {
    if (document.getElementById("tour-cursor") || !document.body) return;
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement("div"); c.id = "tour-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const r = document.createElement("div"); r.id = "tour-ring";
    const cap = document.createElement("div"); cap.id = "tour-cap";
    const chip = document.createElement("div"); chip.id = "tour-chip";
    const card = document.createElement("div"); card.id = "tour-card";
    document.body.append(c, r, cap, chip, card);
  };
  window.__tour = {
    add,
    cursor(x, y, instant) {
      add(); const c = document.getElementById("tour-cursor");
      if (instant) c.style.transition = "none";
      c.style.transform = "translate(" + (x - 4) + "px," + (y - 2) + "px)";
      if (instant) requestAnimationFrame(() => (c.style.transition = ""));
    },
    ripple(x, y) { add(); const d = document.createElement("div"); d.className = "tour-ripple";
      d.style.left = x + "px"; d.style.top = y + "px"; document.body.appendChild(d); setTimeout(() => d.remove(), 700); },
    ring(b) { add(); const r = document.getElementById("tour-ring");
      if (!b) { r.style.opacity = 0; return; }
      Object.assign(r.style, { left: b.x - 6 + "px", top: b.y - 6 + "px", width: b.width + 12 + "px", height: b.height + 12 + "px", opacity: 1 }); },
    caption(t) { add(); const e = document.getElementById("tour-cap"); e.textContent = t || ""; e.style.opacity = t ? 1 : 0;
      e.style.bottom = document.querySelector('[aria-label="Leave or end the webinar"]') ? "96px" : "34px"; },
    chip(t) { add(); document.getElementById("tour-chip").textContent = t; },
    card(o) { add(); const e = document.getElementById("tour-card");
      if (!o) { e.style.display = "none"; return; }
      e.innerHTML = '<div class="k">' + o.kicker + '</div><div class="t">' + o.title + '</div><div class="s">' + (o.sub || "") + '</div><div class="n">' + (o.note || "") + '</div>';
      e.style.display = "flex"; },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

export class Tour {
  constructor({ page, base, cacheDir, chip }) {
    this.page = page;
    this.base = base;
    this.cacheDir = cacheDir;
    this.chipText = chip;
    this.pos = { x: W / 2, y: H / 2 };
    this.clips = [];
    this.t0 = Date.now();
    this.trimAt = 0;
    this.caption = "";
  }

  now() {
    return (Date.now() - this.t0) / 1000;
  }

  async restore() {
    await this.page.evaluate(
      ([p, cap, chip]) => {
        window.__tour?.add();
        window.__tour?.cursor(p.x, p.y, true);
        window.__tour?.caption(cap);
        window.__tour?.chip(chip);
      },
      [this.pos, this.caption, this.chipText],
    ).catch(() => {});
  }

  async goto(path, { wait = 900 } = {}) {
    await this.page.goto(this.base + path, { waitUntil: "networkidle", timeout: 90_000 }).catch(() => {});
    await this.restore();
    await sleep(wait);
  }

  /** Title card, spoken. The video is trimmed to start here. */
  async card(o, line) {
    await this.page.evaluate((o) => window.__tour.card(o), o);
    await sleep(250);
    if (!this.trimAt) this.trimAt = this.now();
    await this.say(line, null, { caption: false });
    await this.page.evaluate(() => window.__tour.card(null));
  }

  /** Speak one line while `act` runs; last as long as the longer of the two. */
  async say(text, act, { caption = true, tail = 350 } = {}) {
    const clip = speak(text, this.cacheDir);
    const start = this.now();
    this.clips.push({ file: clip.file, at: start });
    this.caption = caption ? text : "";
    await this.page.evaluate((t) => window.__tour.caption(t), this.caption).catch(() => {});
    const t = Date.now();
    if (act) {
      try {
        await act();
      } catch (e) {
        console.warn(`    ! action failed during “${text.slice(0, 50)}…”: ${e.message.split("\n")[0]}`);
      }
    }
    const left = clip.seconds * 1000 + tail - (Date.now() - t);
    if (left > 0) await sleep(left);
  }

  async moveTo(locator, { ring = true } = {}) {
    const el = locator.filter({ visible: true }).first();
    await el.waitFor({ state: "visible", timeout: 8000 });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(250);
    const b = await el.boundingBox();
    if (!b) throw new Error("no box");
    const x = Math.round(b.x + Math.min(b.width / 2, 60));
    const y = Math.round(b.y + b.height / 2);
    this.pos = { x, y };
    await this.page.evaluate(([x, y, b, ring]) => {
      window.__tour.cursor(x, y);
      window.__tour.ring(ring ? b : null);
    }, [x, y, b, ring]);
    await this.page.mouse.move(x, y, { steps: 12 });
    await sleep(800);
    return el;
  }

  async point(locator) {
    await this.moveTo(locator);
  }

  async unring() {
    await this.page.evaluate(() => window.__tour.ring(null)).catch(() => {});
  }

  async click(locator, { settle = 900 } = {}) {
    const el = await this.moveTo(locator);
    await this.page.evaluate(([x, y]) => window.__tour.ripple(x, y), [this.pos.x, this.pos.y]);
    await sleep(180);
    await this.unring();
    await el.click();
    await sleep(settle);
    await this.restore();
  }

  async type(locator, text, { clear = true } = {}) {
    const el = await this.moveTo(locator);
    await el.click();
    if (clear) await el.fill("");
    await this.unring();
    await el.pressSequentially(text, { delay: 55 });
  }

  async scroll(dy, { steps = 10 } = {}) {
    await this.unring();
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await sleep(40);
    }
    await sleep(500);
  }

  async key(k) {
    await this.page.keyboard.press(k);
    await sleep(500);
  }

  async wait(ms) {
    await sleep(ms);
  }

  /** Follow the recording into another tab (e.g. the room opens in a new one). */
  async use(page) {
    await page.bringToFront().catch(() => {});
    this.page = page;
    this.segments.push({ page, at: this.now() });
    await this.restore();
  }
}

/** Record one tour into `<outDir>/<id>.mp4`. */
export async function record({ browser, storageState, base, outDir, cacheDir, id, chip, run, contextOptions = {} }) {
  const raw = join(outDir, ".raw", id);
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    storageState,
    recordVideo: { dir: raw, size: { width: W, height: H } },
    ...contextOptions,
  });
  await ctx.addInitScript(OVERLAY);
  const born = new Map();
  let tour;
  ctx.on("page", (p) => born.set(p, tour ? tour.now() : 0));
  const page = await ctx.newPage();
  tour = new Tour({ page, base, cacheDir, chip });
  born.set(page, 0);
  tour.segments = [{ page, at: 0 }];
  await page.setContent(`<html><body style="margin:0;background:#0e0c1d"></body></html>`);
  await page.evaluate(OVERLAY);
  await tour.restore();
  await run(tour, page);
  await tour.say(" ", null, { caption: false, tail: 600 });
  const end = tour.now();
  const paths = [];
  for (const s of tour.segments) paths.push(await s.page.video().path());
  await ctx.close();

  // Each tab has its own video starting when the tab was born: cut the piece
  // of each that was on screen, and join them.
  const args = ["-y", "-v", "error"];
  const vparts = [];
  tour.segments.forEach((s, i) => {
    const from = Math.max(i === 0 ? tour.trimAt : s.at, 0);
    const to = tour.segments[i + 1]?.at ?? end;
    const off = born.get(s.page) ?? 0;
    args.push("-i", paths[i]);
    vparts.push(
      `[${i}:v]trim=start=${(from - off).toFixed(3)}:end=${(to - off).toFixed(3)},setpts=PTS-STARTPTS,fps=25,scale=${W}:${H},setsar=1[v${i}]`,
    );
  });
  const nv = tour.segments.length;
  vparts.push(tour.segments.map((_, i) => `[v${i}]`).join("") + `concat=n=${nv}:v=1:a=0[vout]`);
  const clips = tour.clips.filter((c) => c.at >= tour.trimAt - 0.01);
  for (const c of clips) args.push("-i", c.file);
  const parts = clips.map(
    (c, i) => `[${i + nv}:a]aresample=48000,adelay=${Math.max(0, Math.round((c.at - tour.trimAt) * 1000))}:all=1[a${i}]`,
  );
  const mix = clips.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${clips.length}:normalize=0:dropout_transition=0[aout]`;
  args.push(
    "-filter_complex", [...vparts, ...parts, mix].join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
    join(outDir, `${id}.mp4`),
  );
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  rmSync(raw, { recursive: true, force: true });
  return join(outDir, `${id}.mp4`);
}

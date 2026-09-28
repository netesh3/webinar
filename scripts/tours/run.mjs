/* Record the guided tours.
 *
 *   node scripts/tours/run.mjs                 # every tour
 *   node scripts/tours/run.mjs 02 05           # just these (id prefix match)
 *
 * Needs the local stack up (./start.sh) with the demo coach seeded
 * (make seed-demo): demo@webinarliv.com / demo-coach-2026. Output lands in
 * docs/tours/videos/. Env: TOUR_BASE, TOUR_EMAIL, TOUR_PASSWORD, TOUR_VOICE,
 * TOUR_DB (for the live tour's cleanup).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, record } from "./recorder.mjs";
import { TOURS } from "./tours.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
process.chdir(root);
const BASE = process.env.TOUR_BASE ?? "http://localhost:3000";
const EMAIL = process.env.TOUR_EMAIL ?? "demo@webinarliv.com";
const PASSWORD = process.env.TOUR_PASSWORD ?? "demo-coach-2026";
const DB = process.env.TOUR_DB ?? "postgres://webcast:webcast@localhost:5432/webcast";
const outDir = join(root, "docs/tours/videos");
const cacheDir = join(root, ".run/tour-voice");
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const want = process.argv.slice(2);
const tours = TOURS.filter((t) => !want.length || want.some((w) => t.id.startsWith(w)));

async function launch(extra = []) {
  const args = ["--hide-scrollbars", ...extra];
  return chromium.launch({ args }).catch(() => chromium.launch({ channel: "chrome", args }));
}

// A fake camera, fed from a still of a host, for the in-room tour.
const cam = join(root, ".run/tour-host.y4m");
function mediaArgs() {
  if (!existsSync(cam)) {
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-loop", "1", "-i", "web/public/images/hero/host.jpg", "-t", "6",
      "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p",
      "-r", "25", cam,
    ]);
  }
  return ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${cam}`];
}

function cleanup(sql) {
  if (!sql) return;
  try {
    execFileSync("psql", [DB, "-qtAc", sql.replaceAll("$EMAIL", `'${EMAIL.replaceAll("'", "''")}'`)]);
  } catch (e) {
    console.warn(`  ! cleanup failed: ${e.message.split("\n")[0]}`);
  }
}

const browser = await launch();
const mediaBrowser = tours.some((t) => t.media) ? await launch(mediaArgs()) : null;

// Sign in once, off camera, and reuse the session for every recording.
const login = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lp = await login.newPage();
await lp.goto(`${BASE}/host/login`, { waitUntil: "networkidle", timeout: 120_000 });
if (lp.url().includes("login")) {
  await lp.getByLabel(/email/i).first().fill(EMAIL);
  await lp.getByLabel(/password/i).first().fill(PASSWORD);
  await lp.getByRole("button", { name: /sign in|log in|continue/i }).first().click();
  await lp.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
}
// Warm every page once so the recordings never show a dev-server compile.
for (const t of tours) for (const p of t.warm ?? []) {
  await lp.goto(BASE + p, { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
}
const storageState = await login.storageState();
await login.close();

for (const t of tours) {
  const started = Date.now();
  console.log(`▶ ${t.id} — ${t.title}`);
  cleanup(t.cleanup);
  try {
    const file = await record({
      browser: t.media ? mediaBrowser : browser,
      contextOptions: t.media ? { permissions: ["camera", "microphone"] } : {},
      storageState, base: BASE, outDir, cacheDir, id: t.id,
      chip: `WebinarLiv tour · ${t.title}`,
      run: t.run,
    });
    console.log(`  ✓ ${file} (${Math.round((Date.now() - started) / 1000)}s)`);
  } finally {
    cleanup(t.cleanup);
  }
}
await browser.close();
await mediaBrowser?.close();

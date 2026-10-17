/* Rejoin after a refresh, in a real browser: join the stage, mic off + camera on, reload, and
 * assert the pre-join screen was skipped and the state came back. Then open the webinar's own
 * page and assert it sends the presenter straight back to the stage.
 *
 *   node e2e/probe-rejoin.mjs <base-url> <live-webinar-slug> <host-email> <host-password>
 *
 * Needs a development build (`next dev`): it reads the Room through window.__lkRoom, which
 * production does not expose. And a media path the browser can reach — on a laptop against a
 * loopback LiveKit, headless Chrome's ICE never completes, so run it against an SFU with a
 * routable address. See lib/rejoin.ts for the rules being exercised. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, slug, email, password] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9333;
const dir = mkdtempSync(join(tmpdir(), "rejoin-chrome-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--headless=new",
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--allow-loopback-in-peer-connection", "--force-webrtc-ip-handling-policy=default", "--disable-features=WebRtcHideLocalIpsWithMdns", "about:blank",
], { stdio: "ignore" });

let ws, seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (process.env.DEBUG && m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
            console.log("  [console]", m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
          if (process.env.DEBUG && m.method === "Runtime.exceptionThrown")
            console.log("  [exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 600));
        };
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("no chrome");
}
const call = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function waitFor(expression, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await evaluate(expression)) return; } catch {}
    await sleep(300);
  }
  const where = await evaluate(`location.href + " | " + document.body.innerText.slice(0, 300)`).catch(() => "?");
  throw new Error(`timed out: ${what} @ ${where}`);
}
const go = async (url) => { await call("Page.navigate", { url }); await sleep(500); };
const state = `(() => { const r = window.__lkRoom; if (!r || r.state !== "connected") return null;
  const lp = r.localParticipant; return { mic: lp.isMicrophoneEnabled, cam: lp.isCameraEnabled }; })()`;
const hasPreJoin = `[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Join the webinar")`;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

try {
  await connect();
  await call("Page.enable");
  await call("Runtime.enable");
  await go(`${base}/`);
  const login = await evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) }).then(r => r.status)`);
  check("login", login === 200, `status ${login}`);

  // First visit: the ordinary device check.
  await go(`${base}/host/${slug}/room`);
  await waitFor(hasPreJoin, 60_000, "pre-join screen");
  check("first visit shows pre-join", true);
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Join the webinar").click()`);
  await waitFor(`!!${state}`, 30_000, "connected");

  // Mic off, camera on.
  await evaluate(`(async () => { const lp = window.__lkRoom.localParticipant;
    await lp.setMicrophoneEnabled(false); await lp.setCameraEnabled(true); })()`);
  await waitFor(`(() => { const s = ${state}; return s && !s.mic && s.cam; })()`, 15_000, "mic off cam on");
  await sleep(1500);
  const saved = await evaluate(`sessionStorage.getItem("webcast.rejoin-media.v1.${slug}")`);
  check("media state saved", !!saved && JSON.parse(saved).camera === true && JSON.parse(saved).mic === false, saved ?? "");

  // Refresh: straight back in, no pre-join, same state.
  await call("Page.reload");
  await sleep(1500);
  let sawPreJoin = false;
  const until = Date.now() + 40_000;
  let after = null;
  while (Date.now() < until) {
    try {
      if (await evaluate(hasPreJoin)) sawPreJoin = true;
      after = await evaluate(state);
      if (after && after.cam) break;
    } catch {}
    await sleep(300);
  }
  check("refresh skips pre-join", !sawPreJoin);
  check("refresh restores mic off / camera on", !!after && after.mic === false && after.cam === true, JSON.stringify(after));

  // Reopen the webinar's own page in this tab: sent back to the stage.
  await go(`${base}/webinars/${slug}`);
  await waitFor(`location.pathname === "/host/${slug}/room"`, 20_000, "redirect to stage");
  check("landing page sends a recent presenter back to the stage", true);
  await waitFor(`(() => { const s = ${state}; return s && s.cam && !s.mic; })()`, 40_000, "restored after reopen");
  check("reopen restores mic off / camera on", true);
} catch (e) {
  check("probe", false, String(e));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}

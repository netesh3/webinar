/* End-to-end test: one host and two attendees in the same WebRTC room.
 *
 * Drives three real Chrome instances over the DevTools Protocol (no test-runner
 * dependency; Node's built-in WebSocket is the only transport needed). It walks
 * the flow a real user takes, then asks the SFU directly whether the permissions
 * actually landed — because the UI can be wrong and the SFU cannot.
 *
 * The assertions that matter most:
 *   - no attendee can publish, and none is publishing
 *   - every attendee is HIDDEN at the SFU, so they cannot enumerate each other
 *   - the host can still see them, because that roster comes from the server API
 *   - "mute everyone" silences the stage without muting the host
 *   - a real screen share takes the stage and reaches the audience as pixels
 *   - "allow to speak" grants a microphone and NOTHING else, and can be revoked
 *   - a host mute holds: pressing the button again does not get them back on air
 *   - a recording produces a file a browser will actually decode and play
 *
 * Screen sharing needs `--auto-select-desktop-capture-source` on the host
 * browser (scripts/e2e-browsers.sh passes it); without it getDisplayMedia waits
 * for a picker no one is looking at.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WEB = "http://localhost:3000";
const API = process.env.API_BASE ?? "http://localhost:8080";
const OUT = process.env.E2E_OUT ?? "/tmp/e2e-shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- CDP client

class Browser {
  constructor(label, port) {
    this.label = label;
    this.port = port;
    this.id = 0;
    this.pending = new Map();
  }

  async attach() {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === "page");
        if (page?.webSocketDebuggerUrl) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            this.ws.onopen = res;
            this.ws.onerror = rej;
          });
          this.ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && this.pending.has(m.id)) {
              const { resolve, reject } = this.pending.get(m.id);
              this.pending.delete(m.id);
              m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
          };
          await this.send("Page.enable");
          await this.send("Runtime.enable");
          return;
        }
      } catch {}
      await sleep(250);
    }
    throw new Error(`${this.label}: could not attach on :${this.port}`);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `${this.label} eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`,
      );
    }
    return r.result.value;
  }

  async goto(path, settle = 2500) {
    await this.send("Page.navigate", { url: WEB + path });
    await sleep(settle);
    await this.installHelpers();
  }

  installHelpers() {
    return this.eval(`
      window.__set = (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('no element: ' + sel);
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
                    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      window.__click = (sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('no element: ' + sel);
        el.click(); return true;
      };
      window.__clickText = (text) => {
        const el = [...document.querySelectorAll('button,a')]
          .find(e => e.innerText.trim().toLowerCase().includes(text.toLowerCase()));
        if (!el) throw new Error('no clickable with text: ' + text);
        el.click(); return true;
      };
      window.__has = (sel) => !!document.querySelector(sel);
      window.__count = (sel) => document.querySelectorAll(sel).length;
      window.__body = () => document.body.innerText;
      true;
    `);
  }

  async waitForText(needle, timeoutMs = 25000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const body = await this.eval("document.body.innerText").catch(() => "");
      if (body && body.includes(needle)) return true;
      await sleep(500);
    }
    return false;
  }

  /** Waits for a selector to exist, which is more reliable than a fixed sleep
   *  for anything that appears after a network round trip. */
  async waitForSelector(sel, timeoutMs = 25000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await this.eval(
        `!!document.querySelector(${JSON.stringify(sel)})`,
      ).catch(() => false);
      if (found) return true;
      await sleep(400);
    }
    return false;
  }

  async shot(name, width = 1440, h = 900) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height: h, deviceScaleFactor: 1, mobile: width < 500,
    });
    await sleep(500);
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
    console.log(`     📸 ${name}.png`);
  }
}

/** Asks the SFU directly. The UI can be wrong; the SFU is the authority on who
 *  may publish and who is visible. */
function lkstat(room) {
  const out = execFileSync("go", ["run", "./cmd/lkstat", room], {
    cwd: new URL("../api", import.meta.url).pathname,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// -------------------------------------------------------------------- script

const SLUG = "scaling-webrtc-10k";
const ROOM = `webinar_${SLUG}`;
const HOST_EMAIL = "neeraj@acme.dev";
const HOST_PASSWORD = "webcast-dev";

async function registerAttendee(b, email, first, last) {
  await b.goto(`/webinars/${SLUG}`, 3500);

  // Re-runnable: a profile that already registered sees the confirmed state, so
  // there is no form to fill. Reuse the existing registration.
  const already = await b.eval(
    `document.body.innerText.includes("You're registered")`,
  );
  if (already) {
    const key = await b.eval(
      `JSON.parse(localStorage.getItem('webcast.joinkeys.v1')||'[]')[0] || null`,
    );
    check(`${b.label}: already registered (reused)`, !!key, key ?? "none");
    return key;
  }

  await b.eval(`__set('#firstName', ${JSON.stringify(first)})`);
  await b.eval(`__set('#lastName', ${JSON.stringify(last)})`);
  await b.eval(`__set('#email', ${JSON.stringify(email)})`);
  await b.eval(`__set('#company', 'Test Co')`);
  // The seeded webinar's own required question.
  if (await b.eval(`__has('#stack')`)) {
    await b.eval(`__set('#stack', 'Nothing yet — evaluating')`);
  }
  await sleep(300);
  await b.eval(`__click('button[type="submit"]')`);
  const ok = await b.waitForText("You're registered", 15000);
  check(`${b.label}: registration confirmed`, ok);
  const key = await b.eval(
    `JSON.parse(localStorage.getItem('webcast.joinkeys.v1')||'[]')[0] || null`,
  );
  check(`${b.label}: join key stored`, !!key, key ?? "none");
  return key;
}

/** Which stage layout is selected, read from the switcher's own aria state.
 *  Keyed on `title` rather than the visible label, which is hidden below `sm`. */
function activeView(b) {
  return b.eval(`
    (() => {
      const group = document.querySelector('[role="radiogroup"][aria-label="Stage layout"]');
      if (!group) return null;
      const on = [...group.querySelectorAll('[role="radio"]')]
        .find((r) => r.getAttribute('aria-checked') === 'true');
      return on ? on.getAttribute('title') : null;
    })()
  `);
}

function pickView(b, name) {
  return b.eval(`
    (() => {
      const group = document.querySelector('[role="radiogroup"][aria-label="Stage layout"]');
      if (!group) throw new Error('no stage layout switcher');
      const target = [...group.querySelectorAll('[role="radio"]')]
        .find((r) => r.getAttribute('title') === ${JSON.stringify(name)});
      if (!target) throw new Error('no such view: ' + ${JSON.stringify(name)});
      target.click();
      return true;
    })()
  `);
}

/** The rendered screen-share tile, and whether real frames are arriving.
 *
 *  object-contain is only used for a screen share (a camera tile is object-cover),
 *  so it identifies the tile without needing a test-only attribute. videoWidth is
 *  the part that matters: a laid-out element with 0x0 of video is a subscription
 *  that never produced a frame. */
function shareTile(b) {
  return b.eval(`
    (() => {
      const v = [...document.querySelectorAll('video')]
        .find((el) => el.className.includes('contain'));
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        vw: v.videoWidth, vh: v.videoHeight,
      };
    })()
  `);
}

/** Opens the host's participants panel and waits for the roster to arrive.
 *
 *  Idempotent, because the toggle is a toggle: clicking it a second time would
 *  close the panel again. And it waits for a row rather than sleeping — the roster
 *  is a round trip through our API to the SFU, which after a burst of permission
 *  changes takes longer than any fixed number you would pick. */
async function openParticipants(b) {
  const already = await b.eval(
    `!!document.querySelector('[aria-label="Search participants"]')`,
  );
  if (!already) await b.eval(`__click('[aria-label="Participants"]')`);
  return b.waitForSelector('[aria-label^="Actions for"]', 20000);
}

/** Calls a host endpoint with the host's cookie, taken from the driven browser
 *  so the test uses the same session a real host would. */
async function hostApi(host, method, path, body) {
  const expr = `
    fetch(${JSON.stringify(API + path)}, {
      method: ${JSON.stringify(method)},
      credentials: 'include',
      ${body ? `headers: {'Content-Type':'application/json'}, body: ${JSON.stringify(JSON.stringify(body))}` : ""}
    }).then(async r => ({ status: r.status, body: await r.text() }))
  `;
  const res = await host.eval(expr);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

async function main() {
  const host = new Browser("host", 9222);
  const a1 = new Browser("attendee-1", 9223);
  const a2 = new Browser("attendee-2", 9224);

  console.log("\n▶ attaching to three browsers");
  await Promise.all([host.attach(), a1.attach(), a2.attach()]);
  console.log("  attached");

  // ---- 1. host signs in -------------------------------------------------
  console.log("\n▶ 1. host signs in");
  // ?next= is where a real host arrives from: the "Sign in" call to action on the
  // host portal carries it, so signing in lands back where they were going.
  await host.goto("/login?next=/host", 3000);
  await host.eval(`__set('#email', ${JSON.stringify(HOST_EMAIL)})`);
  await host.eval(`__set('#password', ${JSON.stringify(HOST_PASSWORD)})`);
  await host.eval(`__click('button[type="submit"]')`);
  const signedIn = await host.waitForText("Signed in as Neeraj Kumar", 20000);
  check("host reached the host portal", signedIn);
  await host.shot("01-host-portal");

  // ---- 2. host starts the webinar and joins the stage -------------------
  console.log("\n▶ 2. host starts the webinar (publishes over WebRTC)");
  await host.goto(`/host/${SLUG}/room`, 5000);

  // Publishers get a device check first, so the room is entered by choice
  // rather than by having a camera switched on for them.
  const prejoin = await host.waitForText("Join the webinar", 20000);
  check("host saw the device check before going live", prejoin);
  await host.shot("02-host-prejoin");
  await host.eval(`__clickText('Join the webinar')`);

  const hostInRoom = await host.waitForSelector('[aria-label="Leave the webinar"]', 25000);
  check("host room UI rendered", hostInRoom);
  await sleep(7000); // let ICE settle and the fake camera track publish
  await host.shot("03-host-room");

  // ---- 3. two attendees register and join -------------------------------
  console.log("\n▶ 3. attendee 1 registers");
  const k1 = await registerAttendee(a1, "attendee1@test.dev", "Ada", "One");
  console.log("\n▶ 4. attendee 2 registers");
  const k2 = await registerAttendee(a2, "attendee2@test.dev", "Bo", "Two");
  check("attendees got DIFFERENT join keys", !!k1 && !!k2 && k1 !== k2);
  await a1.shot("04-attendee1-registered");

  console.log("\n▶ 5. attendees join the room");
  await a1.goto(`/webinars/${SLUG}/room`, 6000);
  await a2.goto(`/webinars/${SLUG}/room`, 6000);
  const a1In = await a1.waitForText("view only", 25000);
  const a2In = await a2.waitForText("view only", 25000);
  check("attendee 1 joined and is labelled view-only", a1In);
  check("attendee 2 joined and is labelled view-only", a2In);
  await sleep(7000); // subscribe to the host's track
  await a1.shot("05-attendee1-room");
  // The same room at phone width, because that is where a control bar breaks.
  await a2.shot("06-attendee2-room-mobile", 390, 780);

  // ---- 4. ask the SFU what actually happened ---------------------------
  console.log("\n▶ 6. verifying against the SFU (not the UI)");
  const stat = lkstat(ROOM);
  console.log(JSON.stringify(stat, null, 2));

  const hostP = stat.participants.find((p) => p.identity.startsWith("user_"));
  const attP = stat.participants.filter((p) => p.identity.startsWith("att_"));

  // Assert on the participants THIS run created, plus room-wide invariants. An
  // absolute head count would fail whenever a human is also testing in their own
  // browser — a legitimate state, not a defect.
  const mine = [k1, k2].map((k) => `att_${k}`);
  const foundMine = mine.filter((id) => attP.some((p) => p.identity === id));
  check("both of this run's attendees are in the room",
        foundMine.length === 2, `found ${foundMine.length}/2`);

  check("host is present with publish permission", !!hostP && hostP.canPublish);
  check("host IS publishing at least one track",
        !!hostP && hostP.publishing.length > 0,
        hostP?.publishing.join(",") ?? "none");
  check("host carries the host role in token metadata",
        hostP?.role === "host", hostP?.role ?? "none");

  check("NO attendee in the room has publish permission",
        attP.length > 0 && attP.every((p) => p.canPublish === false),
        attP.map((p) => `${p.identity}:${p.canPublish}`).join(" "));
  check("NO attendee is publishing any track",
        attP.every((p) => (p.publishing?.length ?? 0) === 0),
        attP.map((p) => `${p.identity}:${p.publishing?.join(",") || "none"}`).join(" | "));

  // The privacy guarantee, read straight off the SFU.
  check("EVERY attendee is hidden at the SFU",
        attP.length > 0 && attP.every((p) => p.hidden === true),
        attP.map((p) => `${p.identity}:hidden=${p.hidden}`).join(" "));
  check("the host is NOT hidden (the audience must see them)",
        !!hostP && hostP.hidden === false);

  check("exactly one publisher in the room", stat.publishers === 1,
        `publishers=${stat.publishers}`);

  const others = attP.length - foundMine.length;
  if (others > 0) {
    console.log(`     note: ${others} other attendee(s) also in the room — ` +
                `counted in the invariants above, which they satisfy`);
  }

  // ---- 5. hidden attendees cannot see each other, but the host can ------
  console.log("\n▶ 7. what each side can enumerate");

  // An attendee's own client is only told about the stage. This is the SFU's
  // doing, not a filter in our JavaScript: the participant records never arrive.
  const a1Sees = await a1.eval(`
    (() => {
      const r = window.__lkRoom;
      return r ? [...r.remoteParticipants.values()].map(p => p.identity) : null;
    })()
  `);
  if (a1Sees === null) {
    // No debug handle exposed in production builds — fall back to the UI, which
    // is what a real attendee can actually see.
    await a1.eval(`__click('[aria-label="Participants"]')`);
    await sleep(1200);
    const panel = await a1.eval(`document.body.innerText`);
    check("attendee panel says the audience is private",
          panel.includes("The audience is private"));
    check("attendee panel does NOT name the other attendee",
          !panel.includes("Bo Two"), "looked for 'Bo Two'");
    await a1.shot("07-attendee-participants-private");
  } else {
    check("attendee sees only the stage, not the other attendee",
          !a1Sees.some((id) => id.startsWith("att_")), a1Sees.join(","));
  }

  // The host's roster comes from the server API, so it DOES include them.
  const roster = await hostApi(host, "GET", `/api/host/webinars/${SLUG}/participants`);
  check("host participants endpoint returns 200", roster.status === 200, `status=${roster.status}`);
  const rosterIds = (roster.json?.participants ?? []).map((p) => p.identity);
  check("host CAN see the hidden attendees (server-side roster)",
        mine.every((id) => rosterIds.includes(id)),
        `roster=${rosterIds.join(",")}`);
  check("host roster counts the audience separately",
        (roster.json?.attendees ?? 0) >= 2 && (roster.json?.onStage ?? 0) >= 1,
        `attendees=${roster.json?.attendees} onStage=${roster.json?.onStage}`);

  // ---- 6. attendee UI must not offer publish controls ------------------
  console.log("\n▶ 8. attendee UI has no publish controls");
  const ctrls = await a1.eval(`
    (() => {
      const label = (re) => [...document.querySelectorAll('button')]
        .filter(b => re.test(b.getAttribute('aria-label') || ''));
      return {
        mic: label(/^(Mute|Unmute)$/).length,
        cam: label(/^(Start video|Stop video)$/).length,
        share: label(/^(Share screen|Stop sharing)$/).length,
        leave: label(/^Leave the webinar$/).length,
        chat: !!document.querySelector('textarea[aria-label="Chat message"], [aria-label="Chat"]'),
      };
    })()
  `);
  check("no microphone control for attendee", ctrls.mic === 0, `count=${ctrls.mic}`);
  check("no camera control for attendee", ctrls.cam === 0, `count=${ctrls.cam}`);
  check("no screen-share control for attendee", ctrls.share === 0, `count=${ctrls.share}`);
  check("leave control IS present", ctrls.leave === 1);
  check("chat available to view-only attendee", ctrls.chat === true);

  // ---- 7. the host can mute everyone -----------------------------------
  console.log("\n▶ 9. host mutes everyone");
  const before = lkstat(ROOM);
  const hostLiveBefore = before.participants.find((p) => p.identity.startsWith("user_"));
  check("host microphone is live before muting",
        hostLiveBefore?.audioMuted === false,
        `audioMuted=${hostLiveBefore?.audioMuted}`);

  const muteAll = await hostApi(host, "POST", `/api/host/webinars/${SLUG}/mute-all`);
  check("mute-all returns 200", muteAll.status === 200, `status=${muteAll.status}`);
  await sleep(1500);

  const after = lkstat(ROOM);
  const hostAfter = after.participants.find((p) => p.identity.startsWith("user_"));
  // The host is exempt on purpose: muting yourself with the "mute everyone"
  // button ends with someone presenting in silence.
  check("the HOST is still unmuted after mute-all",
        hostAfter?.audioMuted === false,
        `audioMuted=${hostAfter?.audioMuted}`);
  check("no non-host participant has an open microphone",
        after.participants
          .filter((p) => !p.identity.startsWith("user_"))
          .every((p) => p.audioMuted === true));

  // And it latched, so somebody joining a second later is not live.
  const reread = await hostApi(host, "GET", `/api/host/webinars/${SLUG}/participants`);
  check("mute-all latched mute-on-entry for later joiners",
        reread.json?.controls?.muteOnEntry === true,
        `muteOnEntry=${reread.json?.controls?.muteOnEntry}`);

  // ---- 8. toggling the privacy control reaches the live room ------------
  console.log("\n▶ 10. host un-hides and re-hides the audience");
  const unhide = await hostApi(host, "PATCH", `/api/host/webinars/${SLUG}/controls`,
                              { hideAttendees: false });
  check("controls PATCH returns 200", unhide.status === 200, `status=${unhide.status}`);
  await sleep(2000);

  const unhidden = lkstat(ROOM);
  const unhiddenAtt = unhidden.participants.filter((p) => p.identity.startsWith("att_"));
  check("attendees already connected became visible at the SFU",
        unhiddenAtt.length > 0 && unhiddenAtt.every((p) => p.hidden === false),
        unhiddenAtt.map((p) => `${p.identity}:hidden=${p.hidden}`).join(" "));

  const rehide = await hostApi(host, "PATCH", `/api/host/webinars/${SLUG}/controls`,
                               { hideAttendees: true });
  check("re-hiding returns 200", rehide.status === 200, `status=${rehide.status}`);
  await sleep(2000);

  const rehidden = lkstat(ROOM);
  const rehiddenAtt = rehidden.participants.filter((p) => p.identity.startsWith("att_"));
  check("attendees are hidden again",
        rehiddenAtt.length > 0 && rehiddenAtt.every((p) => p.hidden === true),
        rehiddenAtt.map((p) => `${p.identity}:hidden=${p.hidden}`).join(" "));

  check("the host's roster loaded", await openParticipants(host));
  await host.shot("08-host-participants-panel");

  // The host's own row carries a microphone toggle. It must not go through the
  // mute latch: a host can unmute themselves by right, and latching their own
  // grant would need permissions this endpoint does not own.
  const selfRow = `
    (() => {
      const row = [...document.querySelectorAll('li')]
        .find((li) => li.innerText.includes('(you)'));
      if (!row) return null;
      const b = [...row.querySelectorAll('button')]
        .find((x) => /^(Mute|Unmute) /.test(x.getAttribute('aria-label') || ''));
      return b ? b.getAttribute('aria-label') : null;
    })()
  `;
  const selfLabel = await host.eval(selfRow);
  check("the host's own row offers a microphone toggle",
        typeof selfLabel === "string" && selfLabel.startsWith("Mute "), String(selfLabel));

  // `Mute <name>` with a trailing space, so this cannot match the control bar's
  // own `Mute`. The host is the only person on stage here, so the roster has
  // exactly one of these — an attendee row offers "Ask <name> to unmute" instead.
  await host.eval(`__click('[aria-label^="Mute "]')`);
  await host.waitForSelector('[aria-label^="Unmute "]', 15000);
  const selfMuted = lkstat(ROOM).participants.find((p) => p.identity.startsWith("user_"));
  check("the host can mute their own microphone",
        selfMuted?.audioMuted === true, `audioMuted=${selfMuted?.audioMuted}`);
  check("and their own grant was left alone",
        selfMuted?.canSpeak === true && selfMuted?.mutedByHost === false,
        selfMuted?.permission ?? "none");

  await host.eval(`__click('[aria-label^="Unmute "]')`);
  await host.waitForSelector('[aria-label^="Mute "]', 15000);
  await sleep(1500);
  const selfLive = lkstat(ROOM).participants.find((p) => p.identity.startsWith("user_"));
  check("and turn it back on", selfLive?.audioMuted === false,
        `audioMuted=${selfLive?.audioMuted}`);

  // ---- 9. a screen share takes the stage -------------------------------
  console.log("\n▶ 11. host shares a screen");
  const shareOn = await host.waitForSelector('[aria-label="Share screen"]', 10000);
  check("host has a screen-share control", shareOn);

  await host.eval(`__click('[aria-label="Share screen"]')`);
  // getDisplayMedia, capture, publish, and a subscribe on the far side.
  const sharing = await host.waitForSelector('[aria-label="Stop sharing"]', 30000);
  check("host's share started (capture + publish)", sharing);

  await sleep(4000);
  const shared = lkstat(ROOM);
  const sharer = shared.participants.find((p) => p.identity.startsWith("user_"));
  check("SFU has a SCREEN_SHARE track from the host",
        !!sharer?.publishing?.some((t) => t.includes("SCREEN_SHARE")),
        sharer?.publishing?.join(",") ?? "none");

  // The stage must FOCUS the share. A shared terminal rendered as a half-width
  // thumbnail is the whole bug: the content people are meant to read, too small
  // to read.
  check("stage switched to Speaker view for the share",
        (await activeView(host)) === "Speaker", String(await activeView(host)));

  // The presenter must NOT be shown their own capture. Sharing the whole screen
  // means the capture contains this window — and a window playing back its own
  // capture is the infinite corridor, which the audience then also receives.
  const ownShare = await host.eval(`
    (() => ({
      notice: document.body.innerText.includes("You're sharing your screen"),
      selfPreview: [...document.querySelectorAll('video')]
        .filter((v) => v.className.includes('contain')).length,
    }))()
  `);
  check("the presenter is told their screen is live", ownShare.notice === true);
  check("the presenter is NOT shown their own capture (no mirror)",
        ownShare.selfPreview === 0, `share videos on host = ${ownShare.selfPreview}`);

  // contentHint decides what the encoder sacrifices under pressure. "detail"
  // holds the pixels and drops frames, which is what keeps small text legible.
  //
  // Read off the local track through the development-only room handle: with the
  // self-preview gone there is no <video> on this page to read it from, and the
  // property is sender-side so the receiving end cannot see it either.
  const hint = await host.eval(`
    (() => {
      const room = window.__lkRoom;
      if (!room) return 'no room handle';
      const pub = room.localParticipant.getTrackPublication('screen_share');
      return pub?.track?.mediaStreamTrack?.contentHint ?? 'no screen track';
    })()
  `);
  if (hint === "no room handle") {
    console.log("     note: no dev room handle (production build) — contentHint not checked");
  } else {
    check("captured screen track has contentHint 'detail'", hint === "detail", String(hint));
  }
  await host.shot("09-host-sharing");

  // The point of the whole exercise: real frames arriving at a view-only
  // attendee, not just a publication record at the SFU.
  const attBox = await shareTile(a1);
  check("attendee is receiving the shared screen as decoded frames",
        !!attBox && attBox.vw > 0 && attBox.vh > 0,
        attBox ? `element=${attBox.w}x${attBox.h} video=${attBox.vw}x${attBox.vh}` : "no share tile");
  check("the share takes the attendee's stage, not a thumbnail",
        !!attBox && attBox.w > 900, attBox ? `${attBox.w}px wide` : "no share tile");
  await a1.shot("10-attendee-sees-share");

  // An explicit choice made while the share is up must survive: someone who
  // deliberately wants faces instead of slides gets to keep them. Checked on the
  // attendee, who is the one with two real tiles to choose between.
  await pickView(a1, "Gallery");
  await sleep(1200);
  check("an explicit Gallery choice during the share is respected",
        (await activeView(a1)) === "Gallery", String(await activeView(a1)));
  await pickView(a1, "Speaker");
  await sleep(800);

  await host.eval(`__click('[aria-label="Stop sharing"]')`);
  await sleep(3500);
  check("share stopped cleanly and the control reset",
        await host.eval(`__has('[aria-label="Share screen"]')`));
  const stopped = lkstat(ROOM);
  check("the SCREEN_SHARE track is gone from the SFU",
        !stopped.participants.some((p) => p.publishing?.some((t) => t.includes("SCREEN_SHARE"))));

  // ---- 10. an attendee asks to speak -----------------------------------
  console.log("\n▶ 12. attendee raises their hand");
  const talker = `att_${k2}`;

  // Back to a desktop viewport: step 5 left this browser at phone width to prove
  // the control bar survives it, and the labelled pills below `sm` are glyphs.
  await a2.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(800);

  check("attendee 2 has no microphone control to begin with",
        (await a2.eval(`__count('[aria-label="Mute"],[aria-label="Unmute"]')`)) === 0);

  await a2.eval(`__click('[aria-label="Raise hand"]')`);
  await sleep(2000);
  check("their own control flips to Lower hand",
        await a2.eval(`__has('[aria-label="Lower hand"]')`));

  // The host has to be TOLD. A badge alone means a host watching the video misses
  // the person waiting, which is the whole point of raising a hand.
  const heard = await host.eval(`document.body.innerText.includes('wants to speak')`);
  check("the host is notified that somebody wants to speak", heard === true);
  await host.shot("11-host-hand-raised");

  // ---- 11. "allow to speak": a microphone and nothing else -------------
  //
  // Driven through the host's own panel rather than the endpoint. The API cannot
  // lower a raised hand — the queue lives on the data channel, in browsers — so
  // calling it directly would skip half of what the host's click does.
  console.log("\n▶ 13. host allows them to speak (through the roster UI)");
  check("the host's roster lists the audience", await openParticipants(host));

  const opened = await host.eval(`
    (() => {
      const rows = [...document.querySelectorAll('li')];
      const row = rows.find((li) => li.innerText.includes('Bo Two'));
      if (!row) return 'no row for Bo Two';
      const trigger = row.querySelector('[aria-label^="Actions for"]');
      if (!trigger) return 'no actions menu';
      trigger.click();
      return 'opened';
    })()
  `);
  check("the row for the attendee has an actions menu", opened === "opened", String(opened));
  await sleep(600);

  const chose = await host.eval(`
    (() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((b) => b.innerText.trim().startsWith('Allow to speak'));
      if (!item) return [...document.querySelectorAll('[role="menuitem"]')]
        .map((b) => b.innerText.trim()).join(' | ') || 'no menu items';
      item.click();
      return 'clicked';
    })()
  `);
  check("the menu offers Allow to speak", chose === "clicked", String(chose));

  // Read the invitation before it expires: a toast lives 4.5 seconds, which is
  // shorter than the settle the permission checks below need.
  await sleep(2000);
  const invited = await a2.eval(
    `document.body.innerText.includes('invited you to speak')`,
  );
  await sleep(2500);

  const granted = lkstat(ROOM);
  const talkerP = granted.participants.find((p) => p.identity === talker);
  check("the grant reached the SFU as publish permission",
        talkerP?.canPublish === true && talkerP?.canSpeak === true,
        talkerP?.permission ?? "not in room");
  // The narrow grant is the security property: an audio-only source list, not
  // the empty list that means "every source".
  check("the grant is MICROPHONE ONLY, not a full stage grant",
        !!talkerP?.permission?.includes("(MICROPHONE)"),
        talkerP?.permission ?? "none");
  // Hidden participants are invisible to everyone, tracks included — a hidden
  // speaker would be inaudible, so promoting must unhide.
  check("the promoted attendee is no longer hidden (otherwise nobody hears them)",
        talkerP?.hidden === false, `hidden=${talkerP?.hidden}`);

  const talkerUI = await a2.eval(`
    (() => ({
      mic: __count('[aria-label="Mute"],[aria-label="Unmute"]'),
      cam: __count('[aria-label="Start video"],[aria-label="Stop video"]'),
      share: __count('[aria-label="Share screen"],[aria-label="Stop sharing"]'),
      pill: document.body.innerText.includes('Allowed to speak'),
      handDown: !!document.querySelector('[aria-label="Raise hand"]'),
    }))()
  `);
  check("a microphone control appeared for them", talkerUI.mic === 1, `count=${talkerUI.mic}`);
  check("still NO camera control (audio only means audio only)",
        talkerUI.cam === 0, `count=${talkerUI.cam}`);
  check("still NO screen-share control", talkerUI.share === 0, `count=${talkerUI.share}`);
  check("the UI tells them they may speak", talkerUI.pill === true);
  check("they are told the host invited them", invited === true);
  // Their request has been answered, so their own hand comes down too. Leaving it
  // up means they are still queuing for something they have already been given.
  check("their raised hand was lowered", talkerUI.handDown === true);
  await a2.shot("12-attendee-allowed-to-speak");

  // mute-all latched self-unmute off for the room back in step 9. An individual
  // grant has to override that, or the host allows someone to speak and hands
  // them a dead button.
  await a2.eval(`__click('[aria-label="Unmute"]')`);
  await sleep(4500);
  const speaking = lkstat(ROOM);
  const live = speaking.participants.find((p) => p.identity === talker);
  check("they can unmute despite room-wide self-unmute being off",
        live?.audioMuted === false && live?.publishing?.some((t) => t.includes("MICROPHONE")),
        `audioMuted=${live?.audioMuted} publishing=${live?.publishing?.join(",") || "none"}`);

  const onStage = await hostApi(host, "GET", `/api/host/webinars/${SLUG}/participants`);
  const talkerRow = (onStage.json?.participants ?? []).find((p) => p.identity === talker);
  check("the host roster shows them on stage and able to speak",
        talkerRow?.role === "panelist" && talkerRow?.canSpeak === true,
        `role=${talkerRow?.role} canSpeak=${talkerRow?.canSpeak}`);

  // ---- 12. the host mutes them, and it holds ---------------------------
  console.log("\n▶ 14. host mutes them — and they cannot undo it");
  const mute = await hostApi(
    host, "PATCH", `/api/host/webinars/${SLUG}/participants/${talker}/mute`,
    { muted: true },
  );
  check("mute returns 200", mute.status === 200, `status=${mute.status}`);
  await sleep(3000);

  const silenced = lkstat(ROOM);
  const silencedP = silenced.participants.find((p) => p.identity === talker);
  // The latch is the fix. Muting the track alone leaves them able to unmute a
  // second later, which is what this endpoint used to do — verified against this
  // same SFU before the change.
  check("the microphone is out of their grant at the SFU",
        silencedP?.canSpeak === false, silencedP?.permission ?? "not in room");
  check("the SFU reports them muted by the host, not demoted",
        silencedP?.mutedByHost === true && silencedP?.role === "panelist",
        `mutedByHost=${silencedP?.mutedByHost} role=${silencedP?.role}`);

  // The host's own view of it: still a speaker, marked as one they silenced, with
  // "allow to speak again" as the way back rather than "promote".
  const hostRow = await host.eval(`
    (() => {
      const row = [...document.querySelectorAll('li')]
        .find((li) => li.innerText.includes('Bo Two'));
      if (!row) return null;
      return {
        text: row.innerText.replace(/\\n/g, ' · '),
        back: !!row.querySelector('[aria-label^="Allow Bo Two to speak again"]'),
      };
    })()
  `);
  check("the host's roster says they were muted by the host",
        !!hostRow && /muted by you/i.test(hostRow.text), hostRow?.text ?? "no row");
  check("and offers the way back", hostRow?.back === true);
  await host.shot("14-host-roster-muted-speaker");

  const mutedUI = await a2.eval(`
    (() => ({
      told: document.body.innerText.includes('muted by the host'),
      blocked: __count('[aria-label="Muted by host"]'),
      unmute: __count('[aria-label="Unmute"]'),
    }))()
  `);
  check("they are told the host muted them", mutedUI.told === true);
  check("their control says muted by host", mutedUI.blocked === 1, `count=${mutedUI.blocked}`);
  check("there is no working Unmute for them to press",
        mutedUI.unmute === 0, `count=${mutedUI.unmute}`);
  await a2.shot("13-attendee-muted-by-host");

  // The real test: press it anyway.
  await a2.eval(`__click('[aria-label="Muted by host"]')`);
  await sleep(4000);
  const stillMuted = lkstat(ROOM);
  const stillP = stillMuted.participants.find((p) => p.identity === talker);
  check("clicking the microphone does NOT get them back on air",
        stillP?.audioMuted !== false &&
          !stillP?.publishing?.some((t) => t.includes("MICROPHONE")),
        `audioMuted=${stillP?.audioMuted} publishing=${stillP?.publishing?.join(",") || "none"}`);

  // And the host can hand it back.
  const again = await hostApi(
    host, "PATCH", `/api/host/webinars/${SLUG}/participants/${talker}/mute`,
    { muted: false },
  );
  check("allow-to-speak-again returns 200", again.status === 200, `status=${again.status}`);
  await sleep(3500);
  const restored = lkstat(ROOM);
  const restoredP = restored.participants.find((p) => p.identity === talker);
  check("their microphone is back in the grant",
        restoredP?.canSpeak === true && restoredP?.mutedByHost === false,
        restoredP?.permission ?? "not in room");
  check("and it is still a microphone-only grant",
        !!restoredP?.permission?.includes("(MICROPHONE)"),
        restoredP?.permission ?? "none");
  check("they can unmute again",
        (await a2.eval(`__count('[aria-label="Unmute"],[aria-label="Mute"]')`)) === 1);

  // ---- 13. removing speaker permission ---------------------------------
  console.log("\n▶ 15. host removes speaker permission");
  // Also what keeps this suite re-runnable: the grant is persisted, so leaving it
  // in place would break step 6's "no attendee can publish" on the next run.
  const revoke = await hostApi(
    host, "POST", `/api/host/webinars/${SLUG}/participants/${talker}/stage`,
    { role: "attendee", audioOnly: false },
  );
  check("remove-speaker-permission returns 200", revoke.status === 200, `status=${revoke.status}`);
  await sleep(4000);

  const demoted = lkstat(ROOM);
  const backP = demoted.participants.find((p) => p.identity === talker);
  check("publish permission was withdrawn at the SFU",
        backP?.canPublish === false, backP?.permission ?? "not in room");
  check("their microphone stopped being published",
        (backP?.publishing?.length ?? 0) === 0,
        backP?.publishing?.join(",") || "none");
  check("they are hidden again",
        backP?.hidden === true, `hidden=${backP?.hidden}`);
  check("every microphone control disappeared",
        (await a2.eval(
          `__count('[aria-label="Mute"],[aria-label="Unmute"],[aria-label="Muted by host"]')`,
        )) === 0);
  check("they are back to view-only",
        await a2.eval(`document.body.innerText.includes('View only')`));

  // ---- 14. recording ----------------------------------------------------
  //
  // Driven through the host's own button, and checked by decoding the file at the
  // end. A recording that uploads bytes nobody can play is the failure worth
  // catching, and only a real decode catches it.
  console.log("\n▶ 16. host records the session");

  check("the audience is not offered a record button",
        (await a1.eval(`__count('[aria-label="Start recording"]')`)) === 0);
  check("the host is", (await host.eval(`__count('[aria-label="Start recording"]')`)) === 1);

  await host.eval(`__click('[aria-label="Share screen"]')`);
  await host.waitForSelector('[aria-label="Stop sharing"]', 30000);
  await sleep(3000);

  await host.eval(`__click('[aria-label="Start recording"]')`);
  const recStarted = await host.waitForSelector('[aria-label="Stop recording"]', 20000);
  check("recording started", recStarted);

  const recordings = async () =>
    JSON.parse(
      await host.eval(
        `fetch('${API}/api/host/webinars/${SLUG}/recordings',{credentials:'include'}).then(r=>r.text())`,
      ),
    );
  let recs = await recordings();
  const recId = recs[0]?.id;
  check("the server opened a recording", recs[0]?.status === "recording", recs[0]?.status ?? "none");

  // Consent: this has to reach a browser that is doing none of the recording.
  const attSees = await a1.eval(`document.body.innerText`);
  check("the audience is shown the recording indicator", String(attSees).includes("REC"));
  check("and told in words", String(attSees).includes("being recorded"));
  await a1.shot("15-attendee-sees-recording");
  await host.shot("16-host-recording");

  // Long enough for several chunks, so the append path is exercised rather than a
  // single write. Only "something has arrived" is asserted here on purpose:
  // Chrome's MP4 muxer emits a small header quickly and then batches the media,
  // so a size threshold mid-recording tests the encoder's buffering strategy
  // rather than our upload path. The real size check is after the stop.
  await sleep(14000);
  recs = await recordings();
  check("bytes are arriving", (recs[0]?.sizeBytes ?? 0) > 0, `${recs[0]?.sizeBytes} bytes`);

  const secondStart = await hostApi(host, "POST", `/api/host/webinars/${SLUG}/recordings`,
                                    { mime: "video/webm" });
  check("a second recording is refused", secondStart.status === 409,
        `status=${secondStart.status}`);

  await host.eval(`__click('[aria-label="Stop recording"]')`);
  await host.waitForSelector('[aria-label="Start recording"]', 25000);
  await sleep(3000);
  recs = await recordings();
  const done = recs.find((r) => r.id === recId);
  check("the recording finished as ready", done?.status === "ready", done?.status ?? "gone");
  check("with a duration", (done?.durationMs ?? 0) > 10000, `${done?.durationMs} ms`);
  // The tail arrives after MediaRecorder.stop(), so this is also the check that
  // the recording was not closed before the encoder had handed everything over.
  check("and the whole file, not just the header",
        (done?.sizeBytes ?? 0) > 200_000, `${done?.sizeBytes} bytes`);
  check("the room's indicator cleared",
        !String(await a1.eval(`document.body.innerText`)).includes("REC"));

  // The only check that matters in the end: does a browser play it?
  const playback = await host.eval(`
    (async () => {
      const v = document.createElement('video');
      v.src = '${API}/api/host/webinars/${SLUG}/recordings/${recId}/file';
      v.muted = true;
      document.body.appendChild(v);
      try {
        await new Promise((res, rej) => {
          v.onloadeddata = res;
          v.onerror = () => rej(new Error('decode failed'));
          setTimeout(() => rej(new Error('timed out')), 20000);
        });
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 2500));
        const out = { w: v.videoWidth, h: v.videoHeight, at: v.currentTime };
        v.remove();
        return out;
      } catch (e) { v.remove(); return String(e.message); }
    })()
  `);
  check("the file decodes and plays",
        typeof playback === "object" && playback.w === 1280 && playback.h === 720 &&
          playback.at > 0.2,
        JSON.stringify(playback));

  // Re-runnable: the recordings directory is not a place to leave test files.
  const deleted = await hostApi(host, "DELETE",
                               `/api/host/webinars/${SLUG}/recordings/${recId}`);
  check("the host can delete it", deleted.status === 200, `status=${deleted.status}`);
  await host.eval(`__click('[aria-label="Stop sharing"]')`).catch(() => {});

  console.log(`\n${failures === 0 ? "🎉 ALL CHECKS PASSED" : `💥 ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nE2E DRIVER ERROR:", e.message);
  process.exit(1);
});

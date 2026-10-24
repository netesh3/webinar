/* The load test's own fixture: a test host, its webinar and the viewer seats, made and
 * removed through the API exactly as an admin and a host would (docs/LOAD-TESTING.md).
 *
 *  - The host is a fresh account at <run>@loadtest.invalid. ".invalid" is the reserved TLD:
 *    the API never mails it (verify, welcome, reset, recap all skip it) and it can never be a
 *    customer's address. That is also the rule the server's load-test endpoints enforce
 *    (api/internal/api/admin_loadtest.go), so this kit cannot mark or seat a real webinar.
 *  - Admin steps, with PROBE_ADMIN_EMAIL / PROBE_ADMIN_PASSWORD (an account in ADMIN_EMAILS):
 *    verify the test address, grant hosting (as e2e/grant-host.mjs does), grant instant
 *    webinars, optionally pin the host to a video server, mark the webinar as a load test and
 *    mint name-only viewer seats.
 *  - Cleanup: end, delete the webinar (seats, visits, chat and the mark go with it), delete the
 *    test host. The state file lets `run.mjs --cleanup <file>` finish an interrupted run. */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "./client.mjs";

export const TEST_DOMAIN = "loadtest.invalid";

export function runId() {
  return `lt${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}${randomBytes(2).toString("hex")}`;
}

export async function adminSession(api) {
  const email = process.env.PROBE_ADMIN_EMAIL;
  const password = process.env.PROBE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "PROBE_ADMIN_EMAIL and PROBE_ADMIN_PASSWORD must name an account in the server's ADMIN_EMAILS " +
        "(the kit makes its own test host, which only an admin can verify and grant hosting).",
    );
  }
  return new Session(api, "admin").login(email, password);
}

async function findUser(admin, email) {
  const rows = await admin.call("GET", `/admin/users?kind=all&q=${encodeURIComponent(email)}`);
  const u = (rows ?? []).find((r) => r.email.toLowerCase() === email.toLowerCase());
  if (!u) throw new Error(`no account for ${email}`);
  return u;
}

/** Creates and enables the test host. Returns { email, password, id }. */
export async function createTestHost(api, admin, run, { sfuProject } = {}) {
  const email = `host-${run}@${TEST_DOMAIN}`;
  const password = randomBytes(18).toString("base64url");
  const pub = new Session(api, "signup");
  await pub.call("POST", "/auth/signup", {
    name: `Load Test Host ${run}`,
    email,
    password,
    phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
  });
  const u = await findUser(admin, email);
  await admin.call("POST", `/admin/users/${u.id}/verify-email`);
  await admin.call("PATCH", `/admin/users/${u.id}/host`, { canHost: true });
  await admin.call("PATCH", `/admin/users/${u.id}/features`, { feature: "instant_webinar", enabled: true });
  if (sfuProject) await admin.call("PATCH", `/admin/users/${u.id}/sfu`, { project: sfuProject });
  return { email, password, id: u.id };
}

/** The instant-webinar body the web's "Start now" button sends (host-webinars-screen.tsx). */
export function webinarInput(topic, { delivery = "edge", attendeeLimit = 200 } = {}) {
  return {
    topic,
    summary: "Automated load test. Not a real session.",
    description: "",
    track: "",
    startsAt: new Date().toISOString(),
    durationMin: 120,
    timeZone: "Asia/Kolkata",
    kind: "live",
    status: "scheduled",
    instant: true,
    delivery,
    registrationRequired: true,
    approval: "automatic",
    attendeeLimit,
    passcode: "",
    agenda: [],
    takeaways: [],
    customQuestions: [],
    panelistEmails: [],
    options: {
      practiceSession: false,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
      emailReminders: false,
      whatsappReminders: false,
      reminders: [],
    },
    controls: {
      hideAttendees: true,
      muteOnEntry: true,
      allowUnmute: true,
      chatEnabled: true,
      chatDestination: "everyone",
      pollsEnabled: true,
      qaEnabled: true,
      raiseHandEnabled: true,
      reactionsEnabled: true,
      captionsEnabled: false,
      serverCaptions: false,
      aiEnabled: false,
      aiAvailable: false,
      locked: false,
      audienceLayout: "auto",
    },
  };
}

export async function createWebinar(host, topic, opts) {
  const wb = await host.call("POST", "/host/webinars", webinarInput(topic, opts));
  return wb; // id is the slug
}

/** Marks the webinar as a load test and mints `seats` join keys (1000 a call). */
export async function seatViewers(admin, slug, viewers, seats) {
  await admin.call("PUT", `/admin/webinars/${slug}/load-test`, { viewers });
  const keys = [];
  while (keys.length < seats) {
    const n = Math.min(1000, seats - keys.length);
    const r = await admin.call("POST", `/admin/webinars/${slug}/load-test/seats`, { count: n });
    keys.push(...r.joinKeys);
  }
  return keys;
}

export async function cleanup(state, log = console.log) {
  const api = state.api;
  const errors = [];
  const step = async (what, fn) => {
    try {
      await fn();
      log(`cleanup: ${what}`);
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
      log(`cleanup: ${what} FAILED: ${e.message}`);
    }
  };
  let host = null;
  if (state.host) {
    await step("host login", async () => {
      host = await new Session(api, "host").login(state.host.email, state.host.password);
    });
  }
  if (state.slug) {
    if (host) {
      if (state.recording) {
        // run.mjs --record: the recording's file, by name, before the webinar it belongs to.
        await step(`delete recording ${state.recording}`, () =>
          host.call("DELETE", `/host/webinars/${state.slug}/recordings/${state.recording}`, undefined, { okStatuses: [404, 409] }));
      }
      await step(`end ${state.slug}`, () => host.call("POST", `/host/webinars/${state.slug}/end`, undefined, { okStatuses: [409] }));
      await step(`delete ${state.slug}`, () => host.call("DELETE", `/host/webinars/${state.slug}/`, undefined, { okStatuses: [404] }));
    } else {
      // The host cannot sign in: the admin removes the webinar instead.
      await step(`admin delete ${state.slug}`, async () => {
        const admin = await adminSession(api);
        await admin.call("DELETE", `/admin/webinars/${state.slug}`, undefined, { okStatuses: [404] });
      });
    }
  }
  // The run's other accounts: panelist presenters, and the audience accounts api-load's public
  // registrations made (unverified, .invalid, found by the run id in their address).
  let admin = null;
  const asAdmin = async () => (admin ??= await adminSession(api));
  for (const id of state.extraUsers ?? []) {
    await step(`delete account ${id}`, async () => (await asAdmin()).call("DELETE", `/admin/users/${id}`, undefined, { okStatuses: [404] }));
  }
  if (state.run) {
    await step("delete the run's registrant accounts", async () => {
      const a = await asAdmin();
      let n = 0;
      // The admin search returns 200 at a time: delete a page, ask again, until none are left.
      for (let round = 0; round < 50; round++) {
        const rows = (await a.call("GET", `/admin/users?kind=all&q=${encodeURIComponent(`-${state.run}-`)}`)) ?? [];
        const mine = rows.filter((u) => u.email.endsWith(`@${TEST_DOMAIN}`) && u.email.includes(`-${state.run}-`));
        if (!mine.length) break;
        for (const u of mine) {
          await a.call("DELETE", `/admin/users/${u.id}`, undefined, { okStatuses: [404] });
          n++;
        }
      }
      log(`cleanup: ${n} registrant/panelist account(s) deleted`);
    });
  }
  if (state.host?.id && !state.keepHost) {
    await step(`delete host ${state.host.email}`, async () => {
      await (await asAdmin()).call("DELETE", `/admin/users/${state.host.id}`, undefined, { okStatuses: [404] });
    });
  }
  return errors;
}

/** A presenter who is not the host: a verified .invalid account the host adds as a panelist. */
export async function createPanelist(api, admin, host, slug, run, n) {
  const email = `panelist${n}-${run}-x@${TEST_DOMAIN}`;
  const password = randomBytes(18).toString("base64url");
  await new Session(api, "signup").call("POST", "/auth/signup", {
    name: `Load Panelist ${n}`,
    email,
    password,
    phone: `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
  });
  const u = await findUser(admin, email);
  await admin.call("POST", `/admin/users/${u.id}/verify-email`);
  await host.call("POST", `/host/webinars/${slug}/panelists`, { email });
  return { email, password, id: u.id };
}

/* The state file holds the test host's password (a throwaway for a .invalid account that is
 * deleted at cleanup) so an interrupted run can be cleaned up. Written 0600. */
export function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* Tests for the guest registration journey's pure parts.
 *
 * Run with `make test-web`.
 *
 * Both bugs these cover were silent on the server side: the registration was saved and
 * the email went out, and only the browser got it wrong. A first-time guest's form sat on
 * "Registering…" forever, and the personal link in the email said "You're not registered".
 * Neither shows up for the person testing it, who has registered before in that browser.
 */

import {
  heldRegistrations,
  isAwaitingEmail,
  joinKeyFromSearch,
  joinProvesKey,
} from "./guest-registration.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

type Reg = { webinarId: string; joinKey: string; state: string; needsEmailVerification?: boolean };

const awaiting: Reg = { webinarId: "intro", joinKey: "", state: "unverified", needsEmailVerification: true };
const approved: Reg = { webinarId: "intro", joinKey: "Q25S5CDRKFTB", state: "approved" };
const other: Reg = { webinarId: "second", joinKey: "N6WMUW95HLB6", state: "approved" };

const ids = (rows: Reg[] | null) => (rows === null ? "null" : rows.map((r) => r.webinarId).join(",") || "(none)");

// ---------------------------------------------------------------- heldRegistrations

{
  const held = heldRegistrations<Reg>([], null);
  ok(held !== null && held.length === 0, "a browser with no keys and nothing adopted holds nothing (not 'loading')", ids(held));
}
{
  // The bug: a first-time guest has no keys, and the registration they just made has none yet.
  const held = heldRegistrations([], [awaiting]);
  ok(held?.length === 1 && held[0] === awaiting, "a first-time guest's just-made registration is kept while it waits for the email", ids(held));
}
{
  // A store cleared in another tab: keyed rows from an earlier lookup must not linger.
  const held = heldRegistrations([], [approved, other]);
  ok(held?.length === 0, "keyed rows with no stored key behind them are dropped, as before", ids(held));
}
{
  const held = heldRegistrations([], [approved, awaiting]);
  ok(held?.length === 1 && held[0] === awaiting, "with no keys, only the key-less (awaiting) registration survives", ids(held));
}
{
  ok(heldRegistrations<Reg>(["Q25S5CDRKFTB"], null) === null, "with keys and the lookup still running, the answer is unknown (null)");
}
{
  const rows = [other, awaiting];
  ok(heldRegistrations(["N6WMUW95HLB6"], rows) === rows, "with keys, the lookup's rows and any adopted registration are used as they are");
}

// ---------------------------------------------------------------- isAwaitingEmail

ok(isAwaitingEmail(awaiting), "an unverified registration without a key is awaiting its email");
ok(isAwaitingEmail({ joinKey: "", state: "unverified" }), "state alone is enough when the flag is absent (lookup rows)");
ok(isAwaitingEmail({ joinKey: "", state: "approved", needsEmailVerification: true }), "the flag alone is enough");
ok(!isAwaitingEmail(approved), "an approved registration with a key is not awaiting anything");
ok(!isAwaitingEmail({ joinKey: "PENDINGKEY12", state: "pending" }), "a manual-approval registration is waiting for the host, not the email");
ok(!isAwaitingEmail({ joinKey: "", state: "approved" }), "an approved row without a key (joins by session) is not awaiting email");
ok(!isAwaitingEmail({ joinKey: "Q25S5CDRKFTB", state: "unverified" }), "a row that has a key is usable, whatever its state says");

// ---------------------------------------------------------------- joinKeyFromSearch

const key = (search: string) => joinKeyFromSearch(search);

ok(key("?k=Q25S5CDRKFTB") === "Q25S5CDRKFTB", "reads the key from the emailed link", String(key("?k=Q25S5CDRKFTB")));
ok(key("k=Q25S5CDRKFTB") === "Q25S5CDRKFTB", "works without the leading '?'");
ok(key("?utm_source=whatsapp&k=Q25S5CDRKFTB&x=1") === "Q25S5CDRKFTB", "finds it among other parameters (WhatsApp, trackers)");
ok(key("?k=q25s5cdrkftb") === "Q25S5CDRKFTB", "upper-cases it, as the server does");
ok(key("?k=%20Q25S5CDRKFTB%20") === "Q25S5CDRKFTB", "trims spaces a mail client added");
ok(key("") === null, "no query string → no key");
ok(key("?") === null && key("?x=1") === null, "no k parameter → no key");
ok(key("?k=") === null, "an empty k is not a key");
ok(key("?k=ABC") === null, "too short to be a key → ignored");
ok(key(`?k=${"A".repeat(65)}`) === null, "absurdly long → ignored");
ok(key("?k=%3Cscript%3E") === null, "markup is not a key");
ok(key("?k=Q25S-5CDR-KFTB") === null, "punctuation is not part of a key");
ok(key("?k=Q25S+5CDRKFTB") === null, "a '+' decodes to a space, which no key contains");

// ---------------------------------------------------------------- joinProvesKey

ok(joinProvesKey({ joined: true }), "a successful join proves the key");
for (const code of ["too_early", "not_joinable", "locked", "not_approved", "email_unverified", "room_full", "zoom_link_missing"]) {
  ok(joinProvesKey({ code }), `"${code}" comes after the key matched, so the key is real`);
}
for (const code of ["invalid_join_key", "not_registered", "no_join_key", "bad_request", "unknown", "internal_error"]) {
  ok(!joinProvesKey({ code }), `"${code}" does not prove the key, so it is not kept`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

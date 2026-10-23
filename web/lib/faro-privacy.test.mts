/* What Grafana Faro is allowed to send: no join keys, tokens or emails (lib/faro-privacy.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/faro-privacy.test.mts
 */

import assert from "node:assert/strict";
import { scrubItem, scrubText, scrubValue, stripQuery } from "./faro-privacy.ts";

// Page URLs: the query and fragment go, whatever is in them.
assert.equal(stripQuery("https://webinarliv.com/w/abc?k=secretkey"), "https://webinarliv.com/w/abc");
assert.equal(stripQuery("https://webinarliv.com/recorder-template/x?t=tok&layout=grid"), "https://webinarliv.com/recorder-template/x");
assert.equal(stripQuery("https://webinarliv.com/verify-email?token=abc#done"), "https://webinarliv.com/verify-email");
assert.equal(stripQuery("https://webinarliv.com/reset-password#token=abc"), "https://webinarliv.com/reset-password");
assert.equal(stripQuery("/w/abc?k=1"), "/w/abc");
assert.equal(stripQuery("https://webinarliv.com/pricing"), "https://webinarliv.com/pricing");

// URLs inside free text: an error message, a stack frame.
assert.equal(
  scrubText("Failed to fetch https://webinarliv.com/api/webinars/abc/join?k=secret (403)"),
  "Failed to fetch https://webinarliv.com/api/webinars/abc/join (403)",
);
assert.equal(scrubText("GET /api/join?k=secret failed"), "GET /api/join failed");
assert.equal(scrubText('could not load "/w/abc?t=xyz"'), 'could not load "/w/abc"');
assert.equal(scrubText("wss://sfu.example.com/rtc?access_token=abc.def.ghi&auto_subscribe=1 closed"), "wss://sfu.example.com/rtc closed");
// Not URLs: left alone.
assert.equal(scrubText("Is this ok? yes"), "Is this ok? yes");
assert.equal(scrubText("a/b?c"), "a/b?c");
assert.equal(scrubText("ratio 3/4 #2"), "ratio 3/4 #2");

// Emails, JWTs and bare credential parameters.
assert.equal(scrubText("no account for jane.doe+x@example.co.in"), "no account for [email]");
assert.equal(scrubText("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nat_ure rejected"), "token [token] rejected");
assert.equal(scrubText("bad k=abc123 and token=zzz"), "bad k=[redacted] and token=[redacted]");

// Deep: url keys stripped, other strings scrubbed, non-strings untouched.
assert.deepEqual(
  scrubValue({
    page: { url: "https://webinarliv.com/w/abc?k=1#x", id: "p1" },
    n: 3,
    ok: true,
    none: null,
    list: ["see https://a.example/x?t=2", 4],
  }),
  {
    page: { url: "https://webinarliv.com/w/abc", id: "p1" },
    n: 3,
    ok: true,
    none: null,
    list: ["see https://a.example/x", 4],
  },
);

// A whole Faro transport item: payload and meta scrubbed, any user meta dropped, input intact.
const item = {
  type: "exception",
  payload: {
    type: "Error",
    value: "join failed for https://webinarliv.com/w/abc?k=SECRET",
    stacktrace: { frames: [{ filename: "https://webinarliv.com/_next/static/chunks/app.js?v=1", lineno: 1 }] },
    context: { email: "a@b.io" },
  },
  meta: {
    page: { url: "https://webinarliv.com/w/abc?k=SECRET" },
    user: { email: "a@b.io" },
    session: { id: "anon" },
  },
};
const before = JSON.stringify(item);
const out = scrubItem(item);
assert.equal(JSON.stringify(item), before, "the original item is not modified");
const sent = JSON.stringify(out);
assert.ok(!sent.includes("SECRET"), sent);
assert.ok(!sent.includes("a@b.io"), sent);
assert.equal(out.payload.value, "join failed for https://webinarliv.com/w/abc");
assert.equal(out.payload.stacktrace.frames[0].filename, "https://webinarliv.com/_next/static/chunks/app.js");
assert.equal((out.meta as { page: { url: string } }).page.url, "https://webinarliv.com/w/abc");
assert.equal("user" in out.meta, false);
assert.deepEqual((out.meta as { session: unknown }).session, { id: "anon" });

console.log("faro-privacy: ok");

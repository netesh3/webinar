import assert from "node:assert/strict";
import { noindexHost, wwwRedirect } from "./edge-hosts.ts";

const u = (s: string) => new URL(s);
assert.equal(wwwRedirect(u("https://www.webinarliv.com/pricing?x=1"), "GET"), "https://webinarliv.com/pricing?x=1");
assert.equal(wwwRedirect(u("https://www.webinarliv.com/"), "HEAD"), "https://webinarliv.com/");
assert.equal(wwwRedirect(u("https://www.webinarliv.com/api/auth/me"), "GET"), null);
assert.equal(wwwRedirect(u("https://www.webinarliv.com/login"), "POST"), null);
assert.equal(wwwRedirect(u("https://webinarliv.com/pricing"), "GET"), null);
assert.equal(noindexHost("webinar-web.ganesh-s-p006.workers.dev"), true);
assert.equal(noindexHost("webinarliv.com"), false);
console.log("PASS edge-hosts");

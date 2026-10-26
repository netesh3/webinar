import { test } from "node:test";
import assert from "node:assert/strict";
import { SOCIAL_LINKS } from "./social.ts";

test("every social link is https on its own network's domain, once each", () => {
  const domains = { linkedin: "linkedin.com", instagram: "instagram.com", facebook: "facebook.com", youtube: "youtube.com", x: "x.com" };
  const seen = new Set<string>();
  for (const s of SOCIAL_LINKS) {
    const u = new URL(s.href);
    assert.equal(u.protocol, "https:", s.href);
    assert.ok(u.hostname === domains[s.network] || u.hostname.endsWith("." + domains[s.network]), s.href);
    assert.ok(!seen.has(s.network), `duplicate ${s.network}`);
    seen.add(s.network);
  }
  assert.equal(seen.size, 5);
});

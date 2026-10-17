import assert from "node:assert/strict";
import { phonePromptAllowed } from "./phone-prompt.ts";

const shown = ["/", "/host", "/host/abc", "/host/abc/edit", "/settings", "/admin", "/browse", "/my-webinars", "/pricing"];
const hidden = [
  "/login",
  "/signup",
  "/auth/callback",
  "/host/login",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/webinars/scale-your-coaching",
  "/webinars/scale-your-coaching/room",
  "/webinars/x/recording/y",
  "/w/x/recording/y",
  "/host/abc/room",
  "/recorder-template/x",
  "/preview/room",
  "/mock/survey",
];

for (const p of shown) assert.equal(phonePromptAllowed(p), true, `${p} should show the phone prompt`);
for (const p of hidden) assert.equal(phonePromptAllowed(p), false, `${p} should not show the phone prompt`);
assert.equal(phonePromptAllowed(null), false);

console.log(`PASS  ${shown.length + hidden.length + 1}/${shown.length + hidden.length + 1} checks passed`);

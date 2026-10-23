import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTickRequest, isSuccess, runTick, DEFAULT_TICK_URL } from "../src/index.js";

test("buildTickRequest uses TICK_URL and the secret header", () => {
  const { url, init } = buildTickRequest({ TICK_URL: "https://x/tick", TICK_SECRET: "s" });
  assert.equal(url, "https://x/tick");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Tick-Secret"], "s");
});

test("buildTickRequest falls back to the default URL", () => {
  assert.equal(buildTickRequest({ TICK_SECRET: "s" }).url, DEFAULT_TICK_URL);
});

test("isSuccess accepts ran and busy only on 200", () => {
  assert.ok(isSuccess(200, '{"status":"ran"}'));
  assert.ok(isSuccess(200, '{"status":"busy"}'));
  assert.ok(!isSuccess(200, '{"status":"other"}'));
  assert.ok(!isSuccess(401, '{"status":"busy"}'));
  assert.ok(!isSuccess(200, "not json"));
});

test("runTick skips the call without a secret", async () => {
  let called = false;
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await runTick({}, async () => { called = true; }), false);
  } finally {
    console.error = orig;
  }
  assert.equal(called, false);
});

test("runTick posts, reports busy as success, and never logs the secret", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    const ok = await runTick({ TICK_SECRET: "topsecret" }, async (_url, init) => {
      assert.equal(init.headers["X-Tick-Secret"], "topsecret");
      return new Response('{"status":"busy"}', { status: 200 });
    });
    assert.equal(ok, true);
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("topsecret"));
});

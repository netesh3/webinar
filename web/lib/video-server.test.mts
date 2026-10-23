import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SERVER_FAILED_TITLE,
  SERVER_STARTING_TITLE,
  serverRetryDelayMs,
  serverWaitCopy,
  serverWaitOf,
} from "./video-server.ts";

test("join codes map onto the wait", () => {
  assert.equal(serverWaitOf("sfu_starting"), "starting");
  assert.equal(serverWaitOf("sfu_failed"), "failed");
  assert.equal(serverWaitOf("sfu_unavailable"), null);
  assert.equal(serverWaitOf(undefined), null);
});

test("asks again sooner while starting than once failed", () => {
  assert.equal(serverRetryDelayMs("starting"), 5_000);
  assert.ok(serverRetryDelayMs("failed") > serverRetryDelayMs("starting"));
});

test("starting says about 2 minutes, and admits a long wait", () => {
  const c = serverWaitCopy("starting", true, 10);
  assert.equal(c.title, SERVER_STARTING_TITLE);
  assert.match(c.body, /about 2 minutes/);
  assert.equal(c.retry, false);
  assert.match(serverWaitCopy("starting", false, 300).body, /longer than usual/);
});

test("only the stage gets Try again on a failure", () => {
  const host = serverWaitCopy("failed", true, 0);
  assert.equal(host.title, SERVER_FAILED_TITLE);
  assert.equal(host.retry, true);
  const guest = serverWaitCopy("failed", false, 0);
  assert.equal(guest.retry, false);
  assert.match(guest.body, /by yourself/);
});

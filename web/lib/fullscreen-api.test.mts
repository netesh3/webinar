/* The element Fullscreen API across browsers: standard, webkit-prefixed, and an iPhone
 * with neither (31 Oct 2026).
 *
 * Run: node --experimental-strip-types --no-warnings lib/fullscreen-api.test.mts */

import assert from "node:assert/strict";
import {
  canElementFullscreen,
  exitElementFullscreen,
  fullscreenElement,
  requestElementFullscreen,
  toggleElementFullscreen,
  type FullscreenDocument,
} from "./fullscreen-api.ts";

type Calls = string[];

function standardEl(calls: Calls, refuse = false) {
  return {
    requestFullscreen: async () => {
      calls.push("standard");
      if (refuse) throw new TypeError("Permissions check failed");
    },
  } as unknown as Element;
}

function webkitEl(calls: Calls) {
  return {
    webkitRequestFullscreen: () => {
      calls.push("webkit");
    },
  } as unknown as Element;
}

// An iPhone: a <div> has neither method.
const iphoneEl = {} as Element;

// --- requestElementFullscreen

{
  const calls: Calls = [];
  assert.equal(await requestElementFullscreen(standardEl(calls)), true);
  assert.deepEqual(calls, ["standard"]);
}
{
  // iPadOS / older Safari: only the prefixed method.
  const calls: Calls = [];
  assert.equal(await requestElementFullscreen(webkitEl(calls)), true);
  assert.deepEqual(calls, ["webkit"]);
}
{
  // The Faro error: no requestFullscreen at all. False, not "is not a function".
  assert.equal(await requestElementFullscreen(iphoneEl), false);
  assert.equal(await requestElementFullscreen(null), false);
}
{
  // Standard refused: the prefixed one still gets a go.
  const calls: Calls = [];
  const el = {
    ...(standardEl(calls, true) as object),
    webkitRequestFullscreen: () => {
      calls.push("webkit");
    },
  } as unknown as Element;
  assert.equal(await requestElementFullscreen(el), true);
  assert.deepEqual(calls, ["standard", "webkit"]);
}
{
  // Refused, and nothing else to try: false, never a rejection.
  assert.equal(await requestElementFullscreen(standardEl([], true)), false);
}

// --- fullscreenElement

{
  const el = {} as Element;
  assert.equal(fullscreenElement({ fullscreenElement: el }), el);
  assert.equal(fullscreenElement({ webkitFullscreenElement: el }), el);
  assert.equal(fullscreenElement({ fullscreenElement: null, webkitFullscreenElement: null }), null);
  assert.equal(fullscreenElement({}), null);
  assert.equal(fullscreenElement(null), null);
}

// --- canElementFullscreen

assert.equal(
  canElementFullscreen({ documentElement: standardEl([]), fullscreenEnabled: true }),
  true,
);
assert.equal(
  canElementFullscreen({ documentElement: webkitEl([]), webkitFullscreenEnabled: true }),
  true,
);
// iPhone: no method on elements, and WebKit reports it disabled.
assert.equal(canElementFullscreen({ documentElement: iphoneEl, webkitFullscreenEnabled: false }), false);
// A method, but a permissions policy (an iframe without allowfullscreen).
assert.equal(canElementFullscreen({ documentElement: standardEl([]), fullscreenEnabled: false }), false);
assert.equal(canElementFullscreen(null), false);

// --- exitElementFullscreen

{
  const calls: Calls = [];
  const doc: FullscreenDocument = {
    fullscreenElement: {} as Element,
    exitFullscreen: async () => {
      calls.push("standard");
    },
    webkitExitFullscreen: () => {
      calls.push("webkit");
    },
  };
  await exitElementFullscreen(doc);
  assert.deepEqual(calls, ["standard"]);
}
{
  const calls: Calls = [];
  const doc: FullscreenDocument = {
    webkitFullscreenElement: {} as Element,
    webkitExitFullscreen: () => {
      calls.push("webkit");
    },
  };
  await exitElementFullscreen(doc);
  assert.deepEqual(calls, ["webkit"]);
}
{
  // Nothing fullscreen: nothing called. A throwing exit is swallowed.
  const calls: Calls = [];
  await exitElementFullscreen({
    exitFullscreen: async () => {
      calls.push("standard");
    },
  });
  assert.deepEqual(calls, []);
  await exitElementFullscreen({
    fullscreenElement: {} as Element,
    exitFullscreen: async () => {
      throw new TypeError("Not in fullscreen");
    },
  });
}

// --- toggleElementFullscreen

{
  const calls: Calls = [];
  const el = webkitEl(calls);
  const doc: FullscreenDocument = {
    webkitFullscreenElement: null,
    webkitExitFullscreen: () => {
      calls.push("exit");
    },
  };
  assert.equal(await toggleElementFullscreen(el, doc), true);
  doc.webkitFullscreenElement = el;
  assert.equal(await toggleElementFullscreen(el, doc), true);
  assert.deepEqual(calls, ["webkit", "exit"]);
}
assert.equal(await toggleElementFullscreen(iphoneEl, {}), false);

console.log("fullscreen-api: ok");

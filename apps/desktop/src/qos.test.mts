/* Desktop call QoS: Chromium flags and the process-priority mapping.
 *
 * Run: node --experimental-strip-types --no-warnings src/qos.test.mts
 */

import assert from "node:assert/strict";
import os from "node:os";
import {
  CHROMIUM_QOS_SWITCHES,
  applyChromiumQosFlags,
  callProcessPriorityLevel,
} from "./qos.ts";

assert.deepEqual(
  [...CHROMIUM_QOS_SWITCHES],
  [
    "disable-background-timer-throttling",
    "disable-backgrounding-occluded-windows",
    "disable-renderer-backgrounding",
    "force-high-performance-gpu",
  ],
);

const applied: string[] = [];
applyChromiumQosFlags({ appendSwitch: (s) => applied.push(s) });
assert.deepEqual(applied, [...CHROMIUM_QOS_SWITCHES]);

assert.equal(callProcessPriorityLevel(true), os.constants.priority.PRIORITY_ABOVE_NORMAL);
assert.equal(callProcessPriorityLevel(false), os.constants.priority.PRIORITY_NORMAL);

console.log("desktop-qos: ok");

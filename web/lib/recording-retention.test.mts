/* Recording retention helpers: days left, the storage meter, the admin GB field.
 *
 * Run: node --experimental-strip-types --no-warnings lib/recording-retention.test.mts
 */

import assert from "node:assert/strict";
import {
  daysLeftText,
  daysUntilExpiry,
  expiryTone,
  gbText,
  parseQuotaGB,
  storageMeter,
} from "./recording-retention.ts";

const GB = 1024 ** 3;
const now = Date.parse("2026-10-23T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

// Days left round up, so a recording deleted later today still has "today".
assert.equal(daysUntilExpiry(new Date(now + 30 * day).toISOString(), now), 30);
assert.equal(daysUntilExpiry(new Date(now + 6.2 * day).toISOString(), now), 7);
assert.equal(daysUntilExpiry(new Date(now + 2 * 60 * 60 * 1000).toISOString(), now), 1);
assert.ok((daysUntilExpiry(new Date(now - 60 * 1000).toISOString(), now) ?? 1) <= 0);
assert.equal(daysUntilExpiry(undefined, now), null);
assert.equal(daysUntilExpiry("not a date", now), null);

assert.equal(daysLeftText(0), "Deletes today");
assert.equal(daysLeftText(-2), "Deletes today");
assert.equal(daysLeftText(1), "1 day left");
assert.equal(daysLeftText(30), "30 days left");
assert.equal(expiryTone(7), "warn");
assert.equal(expiryTone(8), "neutral");
assert.equal(expiryTone(null), "neutral");

// The meter.
assert.equal(gbText(6.2 * GB), "6.2 GB");
assert.equal(gbText(10 * GB), "10 GB");
assert.equal(gbText(0), "0 GB");
assert.equal(gbText(12.6 * GB), "13 GB");
assert.deepEqual(storageMeter(6.2 * GB, 10 * GB), { percent: 62, label: "6.2 of 10 GB", tone: "ok" });
assert.deepEqual(storageMeter(9 * GB, 10 * GB), { percent: 90, label: "9 of 10 GB", tone: "warn" });
assert.deepEqual(storageMeter(12 * GB, 10 * GB), { percent: 100, label: "12 of 10 GB", tone: "over" });
assert.equal(storageMeter(10 * GB, 10 * GB).tone, "warn"); // full is not over: Keep longer still works
assert.equal(storageMeter(0, 0).tone, "over");

// The admin field: blank is the plan, junk is refused.
assert.equal(parseQuotaGB("", 10240), null);
assert.equal(parseQuotaGB("  ", 10240), null);
assert.equal(parseQuotaGB("25", 10240), 25 * GB);
assert.equal(parseQuotaGB("0.5", 10240), 0.5 * GB);
assert.equal(parseQuotaGB("0", 10240), undefined);
assert.equal(parseQuotaGB("abc", 10240), undefined);
assert.equal(parseQuotaGB("20000", 10240), undefined);

console.log("recording-retention: ok");

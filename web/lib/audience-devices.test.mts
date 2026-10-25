import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceRows, devicesNote } from "./audience-devices.ts";

test("rows are labelled and shared out of the people whose device is known", () => {
  const rows = deviceRows(
    [
      { key: "phone", count: 2 },
      { key: "desktop", count: 1 },
    ],
    3,
  );
  assert.deepEqual(rows, [
    { key: "phone", label: "Phone", count: 2, pct: 67 },
    { key: "desktop", label: "Desktop", count: 1, pct: 33 },
  ]);
  assert.equal(deviceRows([{ key: "other", count: 1 }], 1)[0].label, "Other");
  assert.equal(deviceRows([{ key: "Samsung Internet", count: 1 }], 1)[0].label, "Samsung Internet");
  assert.equal(deviceRows([{ key: "phone", count: 0 }], 0)[0].pct, 0);
});

test("the note says how many people the numbers cover", () => {
  const base = { classes: [], os: [], browsers: [] };
  assert.equal(devicesNote({ ...base, attendees: 0, recorded: 0 }), "Nobody has joined yet.");
  assert.equal(
    devicesNote({ ...base, attendees: 1, recorded: 1 }),
    "1 person, counted once each on the device they first joined on.",
  );
  assert.match(devicesNote({ ...base, attendees: 5, recorded: 3 }), /^3 people of 5 — 2 joined before/);
});

/* Times, as an audience reads them.
 *
 * Only the zone-facing helpers are covered, and deliberately so: they are the ones where a
 * wrong answer is a person joining an hour late or a day early, and where the mistake looks
 * exactly like a correct answer on screen. Formatting a duration or a byte count is either
 * obviously right or obviously wrong the first time anybody looks at it.
 *
 * Run: node --experimental-strip-types --no-warnings lib/format.test.mts
 */
import {
  DEFAULT_TIME_ZONE,
  formatDay,
  formatElapsed,
  formatTime,
  formatTimeRange,
  instantToZoned,
  tzLabel,
  tzOffsetMinutes,
  zonedToInstant,
} from "./format.ts";

let passed = 0;
let failed = 0;

function is(label: string, got: unknown, want: unknown) {
  if (got === want) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}\n        got  ${String(got)}\n        want ${String(want)}`);
  }
}
function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

/* An instant in the middle of the northern summer, so the zones that observe DST are in it
 * and the ones that do not are visibly unaffected. 21:46 UTC is 03:16 the NEXT day in India,
 * which also exercises the date rolling over — the case where a wrong zone shows the wrong
 * day, not merely the wrong hour. */
const SUMMER = "2026-09-08T21:46:00.000Z";
/* And one in January, because a label cached from a summer render would still say EDT. */
const WINTER = "2026-01-15T21:46:00.000Z";

console.log("tzLabel");
is("Asia/Kolkata is IST, not an offset", tzLabel(SUMMER, "Asia/Kolkata"), "IST");
is("the default zone is IST", tzLabel(SUMMER, DEFAULT_TIME_ZONE), "IST");
/* A zone CLDR has no abbreviation for falls back to the offset rather than to the IANA name.
 * "GMT-4" is readable; "America/New_York" next to a time is not a zone label. */
ok(
  "New York falls back to a GMT offset",
  /^GMT[+-]\d/.test(tzLabel(SUMMER, "America/New_York")),
  `got ${tzLabel(SUMMER, "America/New_York")}`,
);
/* The label has to follow DST, which is only visible across two dates. A zone whose offset
 * changes must not print the same label in both. */
ok(
  "a DST zone's label differs between summer and winter",
  tzLabel(SUMMER, "America/New_York") !== tzLabel(WINTER, "America/New_York"),
  `both ${tzLabel(SUMMER, "America/New_York")}`,
);
/* And a zone without DST must NOT differ, or the label is tracking something else. */
is("India's label is the same year round", tzLabel(WINTER, "Asia/Kolkata"), "IST");
/* An unknown zone must not throw into a render. Whatever comes back, a string is enough. */
ok("a nonsense zone does not throw", typeof tzLabel(SUMMER, "Mars/Olympus") === "string");

console.log("the clock and the day follow the zone, not the machine");
is("21:46 UTC is 03:16 in India", formatTime(SUMMER, "Asia/Kolkata"), "03:16");
is("21:46 UTC is 17:46 in New York", formatTime(SUMMER, "America/New_York"), "17:46");
/* The date rolls over. This is the assertion that catches a formatter which pins the zone for
 * the time and forgets to for the day — the two are separate calls. */
ok(
  "the Indian render is the next day",
  formatDay(SUMMER, "Asia/Kolkata").includes("9 Sept"),
  `got ${formatDay(SUMMER, "Asia/Kolkata")}`,
);
ok(
  "the New York render is still the 8th",
  formatDay(SUMMER, "America/New_York").includes("8 Sept"),
  `got ${formatDay(SUMMER, "America/New_York")}`,
);
is(
  "a 45-minute webinar spans the hour",
  formatTimeRange(SUMMER, 45, "Asia/Kolkata"),
  "03:16 – 04:01",
);
/* Midnight, where a 24-hour formatter that renders hour 24 would show "24:00" and a
 * 12-hour one would silently lose the am/pm. */
is("midnight is 00:00", formatTime("2026-09-08T18:30:00.000Z", "Asia/Kolkata"), "00:00");

console.log("offsets");
is("India is +330", tzOffsetMinutes(new Date(SUMMER), "Asia/Kolkata"), 330);
is("New York is -240 in summer", tzOffsetMinutes(new Date(SUMMER), "America/New_York"), -240);
is("New York is -300 in winter", tzOffsetMinutes(new Date(WINTER), "America/New_York"), -300);
is("an unknown zone reads as UTC", tzOffsetMinutes(new Date(SUMMER), "Mars/Olympus"), 0);

console.log("a wall clock in a zone is an instant, and back again");
/* What the schedule form does: somebody types 09:00 and picks a zone. The stored instant is
 * UTC, which is the whole of task 2's database half. */
is(
  "09:00 in India is 03:30 UTC",
  zonedToInstant("2026-09-09", "09:00", "Asia/Kolkata")?.toISOString(),
  "2026-09-09T03:30:00.000Z",
);
is(
  "09:00 in New York is 13:00 UTC in September",
  zonedToInstant("2026-09-09", "09:00", "America/New_York")?.toISOString(),
  "2026-09-09T13:00:00.000Z",
);
is(
  "and 14:00 UTC in January",
  zonedToInstant("2026-01-15", "09:00", "America/New_York")?.toISOString(),
  "2026-01-15T14:00:00.000Z",
);
is("a malformed date is null, not an Invalid Date", zonedToInstant("", "09:00", "UTC"), null);

/* The round trip is the property that matters for editing a webinar: the host must see the
 * hour they scheduled, not the hour it happens to be where the browser is. Checked across
 * a DST boundary in both directions, which is where the two-pass correction earns its keep. */
for (const [date, time, zone] of [
  ["2026-09-09", "09:00", "Asia/Kolkata"],
  ["2026-01-15", "23:30", "America/New_York"],
  ["2026-03-08", "03:30", "America/New_York"], // the hour after the spring-forward gap
  ["2026-11-01", "01:30", "America/New_York"], // the ambiguous hour, repeated
  ["2026-06-30", "00:00", "Australia/Sydney"],
] as const) {
  const instant = zonedToInstant(date, time, zone);
  ok(`${date} ${time} ${zone} is a real instant`, instant !== null);
  if (!instant) continue;
  const back = instantToZoned(instant.toISOString(), zone);
  is(`${date} ${time} ${zone} round-trips the date`, back.date, date);
  is(`${date} ${time} ${zone} round-trips the time`, back.time, time);
}

console.log("elapsed session clock");
/* Counts from a server start stamp, not from "now when the component mounted".
 * A late joiner and someone who was there from the start must agree. */
const LIVE_START = "2026-09-11T10:00:00.000Z";
is(
  "twelve minutes after host start",
  formatElapsed(LIVE_START, Date.parse("2026-09-11T10:12:07.000Z")),
  "12:07",
);
is(
  "past an hour",
  formatElapsed(LIVE_START, Date.parse("2026-09-11T11:04:32.000Z")),
  "1:04:32",
);
is(
  "before start clamps to zero",
  formatElapsed(LIVE_START, Date.parse("2026-09-11T09:59:00.000Z")),
  "0:00",
);
is(
  "endedAt freezes the final duration",
  formatElapsed(LIVE_START, Date.parse("2026-09-11T10:45:00.000Z")),
  "45:00",
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`,
);
process.exit(failed === 0 ? 0 : 1);

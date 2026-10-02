/* The series schedule, before it ever reaches the API.
 *
 * A wrong date here is a host who thinks they booked seven Fridays and
 * booked six, or a 31st that quietly became the 1st of the next month.
 *
 * Run: node --experimental-strip-types --no-warnings lib/recurrence.test.mts
 */
import {
  planRecurrence,
  type RecurrenceForm,
  weekday,
} from "./recurrence.ts";

let passed = 0;
let failed = 0;

function is(label: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}

function daily(over: Partial<RecurrenceForm> = {}): RecurrenceForm {
  return {
    pattern: "daily",
    interval: 1,
    weekdays: [],
    end: "after_count",
    endDate: "",
    endCount: 7,
    ...over,
  };
}

const seven = planRecurrence("2026-10-02", daily());
is(
  "daily seven dates",
  seven.dates,
  ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
);
is("daily seven summary", seven.summary, "Every day, 7 occurrence(s)");
is("daily seven has no error", seven.error, null);

const until = planRecurrence("2026-10-02", daily({ end: "by_date", endDate: "2026-10-08", endCount: 0 }));
is("until Oct 8 is seven", until.dates.length, 7);
is(
  "until date summary",
  until.summary,
  "Every day, until Oct 8, 2026, 7 occurrence(s)",
);

const weekly = planRecurrence("2026-10-05", {
  pattern: "weekly",
  interval: 1,
  weekdays: [1, 3],
  end: "after_count",
  endDate: "",
  endCount: 4,
});
is("Mon+Wed", weekly.dates, ["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"]);
is("weekday of the start", weekday("2026-10-05"), 1);

const fortnight = planRecurrence("2026-10-05", {
  pattern: "weekly",
  interval: 2,
  weekdays: [1, 3],
  end: "after_count",
  endDate: "",
  endCount: 4,
});
is("every 2 weeks", fortnight.dates, ["2026-10-05", "2026-10-07", "2026-10-19", "2026-10-21"]);

const mondayOnly = planRecurrence("2026-10-05", {
  pattern: "weekly",
  interval: 1,
  weekdays: [1],
  end: "after_count",
  endDate: "",
  endCount: 3,
});
is("Mon only", mondayOnly.dates, ["2026-10-05", "2026-10-12", "2026-10-19"]);
is("Mon only summary", mondayOnly.summary, "Every week on Monday, 3 occurrence(s)");

// 2026-10-03 is a Saturday. The series uses Monday only, and Oct 9 still ends it.
const saturdayOmitted = planRecurrence("2026-10-03", {
  pattern: "weekly",
  interval: 1,
  weekdays: [1],
  end: "by_date",
  endDate: "2026-10-09",
  endCount: 1,
});
is("Saturday can be omitted", saturdayOmitted.dates, ["2026-10-05"]);
is(
  "omitted Saturday summary",
  saturdayOmitted.summary,
  "Every week on Monday, until Oct 9, 2026, 1 occurrence(s)",
);
is("omitted Saturday has no error", saturdayOmitted.error, null);

const saturdayKept = planRecurrence("2026-10-03", {
  pattern: "weekly",
  interval: 1,
  weekdays: [6],
  end: "by_date",
  endDate: "2026-10-09",
  endCount: 1,
});
is("Saturday still runs when selected", saturdayKept.dates, ["2026-10-03"]);

const emptyDays = planRecurrence("2026-10-03", {
  pattern: "weekly",
  interval: 1,
  weekdays: [],
  end: "by_date",
  endDate: "2026-10-09",
  endCount: 1,
});
is("empty weekdays rejected", emptyDays.error, "Select at least one day.");
is("empty weekdays write no dates", emptyDays.dates, []);

const monthly = planRecurrence("2026-01-31", {
  pattern: "monthly",
  interval: 1,
  weekdays: [],
  end: "after_count",
  endDate: "",
  endCount: 5,
});
is("31st skips short months", monthly.dates, [
  "2026-01-31",
  "2026-03-31",
  "2026-05-31",
  "2026-07-31",
  "2026-08-31",
]);
is(
  "skipped months",
  monthly.skipped.includes("February 2026") &&
    monthly.skipped.includes("April 2026") &&
    monthly.skipped.includes("June 2026") &&
    !monthly.skipped.includes("August 2026"),
  true,
);
is("summary names the skip", monthly.summary.includes("no 31st"), true);

const tooMany = planRecurrence("2026-01-01", daily({ endCount: 61 }));
is("61 is refused", tooMany.error?.includes("60") ?? false, true);
is("61 writes no dates", tooMany.dates, []);

const exactly = planRecurrence("2026-01-01", daily({ endCount: 60 }));
is("60 is allowed", exactly.dates.length, 60);
is("60 has no error", exactly.error, null);

const pastEnd = planRecurrence("2026-10-02", daily({ end: "by_date", endDate: "2026-10-01" }));
is("end before start", pastEnd.error !== null, true);

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);

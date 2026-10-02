/* The schedule a recurring series repeats on.
 *
 * Dates are calendar dates in the host's chosen zone (the YYYY-MM-DD the
 * form already holds), not UTC midnights. Adding a day is that calendar,
 * so a series does not land a day early or late when the zone is not UTC.
 */

export const MAX_OCCURRENCES = 60;

export const TOO_MANY =
  "A series can have at most 60 sessions. Shorten it or end it sooner.";

export type RecurrencePattern = "daily" | "weekly" | "monthly";
export type RecurrenceEnd = "by_date" | "after_count";

export type RecurrenceForm = {
  pattern: RecurrencePattern;
  interval: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  end: RecurrenceEnd;
  /** YYYY-MM-DD, inclusive, in the series zone. */
  endDate: string;
  endCount: number;
};

export type RecurrencePlan = {
  dates: string[];
  skipped: string[];
  summary: string;
  error: string | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export function defaultRecurrence(date: string): RecurrenceForm {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "2026-01-01";
  return {
    pattern: "daily",
    interval: 1,
    weekdays: [weekday(start)],
    end: "by_date",
    endDate: addDays(start, 6),
    endCount: 7,
  };
}

export function planRecurrence(date: string, form: RecurrenceForm): RecurrencePlan {
  const rule = form;
  const fail = (error: string): RecurrencePlan => ({
    dates: [],
    skipped: [],
    summary: "",
    error,
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail("Pick a valid date and time.");
  }
  if (rule.interval < 1 || rule.interval > 99) {
    return fail("Repeat every 1 to 99.");
  }
  if (rule.pattern === "weekly" && rule.weekdays.length === 0) {
    return fail("Select at least one day.");
  }
  if (rule.end === "by_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.endDate)) {
      return fail("Pick the date the series ends.");
    }
    if (rule.endDate < date) {
      return fail("The end date is before the first session.");
    }
  } else if (rule.endCount < 1) {
    return fail("Say how many sessions the series runs.");
  } else if (rule.endCount > MAX_OCCURRENCES) {
    return fail(TOO_MANY);
  }

  const dates: string[] = [];
  const skipped: string[] = [];
  const push = (day: string): "ok" | "stop" | "too-many" => {
    if (rule.end === "by_date" && day > rule.endDate) return "stop";
    if (rule.end === "after_count" && dates.length >= rule.endCount) return "stop";
    if (dates.length >= MAX_OCCURRENCES) return "too-many";
    dates.push(day);
    return "ok";
  };

  if (rule.pattern === "daily") {
    for (let i = 0; i < MAX_OCCURRENCES + 366; i++) {
      const step = push(addDays(date, i * rule.interval));
      if (step === "too-many") return fail(TOO_MANY);
      if (step === "stop") break;
    }
  } else if (rule.pattern === "weekly") {
    const week0 = startOfWeek(date);
    const days = [...rule.weekdays].sort((a, b) => a - b);
    // Align to the first week that has a selected day on or after the start,
    // so clearing the start date's weekday begins on the next chosen day
    // instead of skipping a whole interval.
    let anchor = 0;
    for (let w = 0; w < 7; w++) {
      const week = addDays(week0, w * 7);
      if (days.some((wd) => addDays(week, wd) >= date)) {
        anchor = w;
        break;
      }
    }
    for (let n = 0; n < MAX_OCCURRENCES * 8; n++) {
      const week = addDays(week0, (anchor + n * rule.interval) * 7);
      if (rule.end === "by_date" && n > 0 && week > rule.endDate) break;
      let stopped = false;
      for (const wd of days) {
        const day = addDays(week, wd);
        if (day < date) continue;
        const step = push(day);
        if (step === "too-many") return fail(TOO_MANY);
        if (step === "stop") {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
  } else {
    const [y0, m0] = date.split("-").map(Number);
    const monthlyDay = Number(date.slice(8, 10));
    for (let i = 0; i < MAX_OCCURRENCES * 12; i++) {
      if (rule.end === "after_count" && dates.length >= rule.endCount) break;
      const { year, month } = addMonths(y0, m0, i * rule.interval);
      const monthStart = iso(year, month, 1);
      if (rule.end === "by_date" && monthStart > rule.endDate) break;
      if (daysInMonth(year, month) < monthlyDay) {
        skipped.push(`${MONTHS[month - 1]} ${year}`);
        continue;
      }
      const step = push(iso(year, month, monthlyDay));
      if (step === "too-many") return fail(TOO_MANY);
      if (step === "stop") break;
    }
  }

  if (dates.length === 0) {
    return fail("That schedule has no sessions. Move the end date or add another occurrence.");
  }
  return {
    dates,
    skipped,
    summary: summary(rule, dates.length, skipped, Number(date.slice(8, 10))),
    error: null,
  };
}

function summary(
  rule: RecurrenceForm,
  count: number,
  skipped: string[],
  monthlyDay: number,
): string {
  let head = "Every session";
  if (rule.pattern === "daily") {
    head = rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`;
  } else if (rule.pattern === "weekly") {
    head = rule.interval === 1 ? "Every week" : `Every ${rule.interval} weeks`;
    const names = [...rule.weekdays]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAYS[d]);
    if (names.length) head += ` on ${joinAnd(names)}`;
  } else {
    head = rule.interval === 1 ? "Every month" : `Every ${rule.interval} months`;
    head += ` on the ${ordinal(monthlyDay)}`;
  }
  if (rule.end === "by_date" && rule.endDate) {
    head += `, until ${shortDate(rule.endDate)}`;
  }
  head += `, ${count} occurrence(s)`;
  if (skipped.length) {
    head += `. ${joinAnd(skipped)} ${skipped.length === 1 ? "is" : "are"} skipped — ${
      skipped.length === 1 ? "that month has" : "those months have"
    } no ${ordinal(monthlyDay)}`;
  }
  return head;
}

export function weekday(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function startOfWeek(isoDate: string): string {
  return addDays(isoDate, -weekday(isoDate));
}

function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const total = month - 1 + n;
  return { year: year + Math.floor(total / 12), month: (total % 12) + 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

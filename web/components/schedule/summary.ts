import type { FormState } from "./form-state";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The wall clock the host picked, as the sticky bar reads it. Built from the
 *  input strings so it does not depend on the viewer's zone. */
export function formatScheduleWhen(
  date: string,
  time: string,
  zoneLabel: string,
): string | null {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (![y, m, d, hh, mm].every((n) => Number.isFinite(n))) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 || 12;
  const clock = `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
  const when = `${weekday} ${d} ${MONTHS[m - 1]}, ${clock}`;
  return zoneLabel ? `${when} ${zoneLabel}` : when;
}

function formatDuration(minutes: number): string | null {
  if (!minutes) return null;
  return minutes >= 60
    ? `${minutes / 60} hour${minutes > 60 ? "s" : ""}`
    : `${minutes} minutes`;
}

export function shortTimeZone(timeZone: string, at: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/** One line for the action bar, from the form as it stands. A part that is
 *  still empty is left out; a switch that is off is said, because off is a
 *  choice the host already made. */
export function scheduleSummary(
  form: FormState,
  zoneLabel: string,
): { lead: string | null; rest: string } {
  const parts: string[] = [];
  const duration = formatDuration(form.durationMin);
  if (duration) parts.push(duration);
  parts.push(
    form.registrationRequired
      ? form.approval === "manual"
        ? "Registration on, manual approval"
        : "Registration on, auto-approve"
      : "Registration off",
  );
  if (form.attendeeLimit > 0) {
    parts.push(`${form.attendeeLimit.toLocaleString()} seats`);
  }
  return {
    lead: formatScheduleWhen(form.date, form.time, zoneLabel),
    rest: parts.join(" · "),
  };
}

/** Date helpers.
 *
 *  Every formatter pins BOTH locale and timeZone. Without that, the server
 *  renders in the container's zone and the browser re-renders in the user's,
 *  and React reports a hydration mismatch on a page that looks fine.
 */

const LOCALE = "en-GB";

export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));
}

export function formatDayShort(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

/** "09:00 – 10:00" */
export function formatTimeRange(
  iso: string,
  durationMin: number,
  timeZone: string,
): string {
  const end = new Date(new Date(iso).getTime() + durationMin * 60_000);
  return `${formatTime(iso, timeZone)} – ${formatTime(end.toISOString(), timeZone)}`;
}

/* "IST" / "GMT-4" — shown next to every time so nobody joins an hour late.
 *
 * Formatted in en-IN rather than in LOCALE, and this is the only formatter in the file that
 * departs from it. `shortOffset` renders Asia/Kolkata as "GMT+5:30" in every English locale;
 * en-IN with `short` renders it "IST", which is what the audience calls it, what the host
 * wrote on the invitation, and what the API prints in its own refusal messages (see
 * localTime in api/internal/api/host.go). Two spellings of one zone across a product is the
 * kind of detail that makes somebody re-check whether they have the right meeting.
 *
 * Zones CLDR has no abbreviation for still come out as a GMT offset — "GMT-4" for New York —
 * so this is a strict improvement rather than a lookup table that goes stale. The locale is
 * pinned for the same reason every other formatter here pins one: a label that differs
 * between the server render and the browser is a hydration mismatch.
 *
 * Asia/Colombo also renders "IST", sharing the abbreviation with India. Harmless: it shares
 * the offset too, so the wall clock either way is the same.
 */
export function tzLabel(iso: string, timeZone: string): string {
  /* Each attempt is guarded separately, because there are two different failures here and
   * only one of them is about the locale: an engine with no en-IN data, and a zone name the
   * engine rejects outright. `new Intl.DateTimeFormat` throws a RangeError on an unknown
   * zone, so a single try around both leaves the fallback throwing from inside the catch —
   * out of a component's render, where it takes the page down over a label. */
  const label = (locale: string, timeZoneName: "short" | "shortOffset") => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
        .formatToParts(new Date(iso))
        .find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };

  return label("en-IN", "short") ?? label(LOCALE, "shortOffset") ?? timeZone;
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Groups the browse list into "This week" / "Next week" / "Later". */
export function bucketFor(iso: string, now: Date): "week" | "next" | "later" {
  const days = (new Date(iso).getTime() - now.getTime()) / 86_400_000;
  if (days < 7) return "week";
  if (days < 14) return "next";
  return "later";
}

export function formatCount(n: number): string {
  return n.toLocaleString(LOCALE);
}

/** "1:04:32" / "12:07" — an elapsed timer for a running session. */
export function formatElapsed(sinceIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "1:04:32" / "12:07" — the same clock as formatElapsed, from a duration in
 *  milliseconds rather than a start time. Used for a recording's length, which is
 *  measured by the recorder and not derived from wall time. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "48.2 MB". Decimal units, not binary: it is the number the operating system
 *  and every storage bill also use, so matching them beats being pedantic. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const decimals = value < 10 && unit > 1 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** "in 2 hours" / "3 days ago" — relative, for cards and lists. */
export function formatRelative(iso: string, now: Date): string {
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  const diffMs = new Date(iso).getTime() - now.getTime();
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["week", 604_800_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return rtf.format(Math.round(diffMs / 1000), "second");
}

/* ------------------------------------------------------------ time zones
 *
 * Zones come from the platform, never from a list in this repo. A hardcoded set
 * of four cities is wrong for most of the world and goes stale every time a
 * country changes its rules; Intl already ships the current IANA database.
 */

/** Every zone this browser knows, sorted by UTC offset then name — the order a
 *  picker is actually scanned in. Falls back to the viewer's own zone plus UTC on
 *  an engine without supportedValuesOf. */
export function timeZoneNames(): string[] {
  const supported = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    }
  ).supportedValuesOf;

  let zones: string[];
  if (typeof supported === "function") {
    try {
      zones = supported("timeZone");
    } catch {
      zones = [];
    }
  } else {
    zones = [];
  }

  if (zones.length === 0) {
    const local = localTimeZone();
    zones = local === "UTC" ? ["UTC"] : [local, "UTC"];
  }

  const now = new Date();
  return [...zones].sort((a, b) => {
    const delta = tzOffsetMinutes(now, a) - tzOffsetMinutes(now, b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
}

/* The default display zone: IST unless the browser knows better.
 *
 * The fallback used to be UTC, which is right for nobody who attends — a webinar rendered in
 * UTC is five and a half hours away from when it actually happens for this audience, and the
 * host does not notice because their own browser reports a zone. It only bites where the
 * browser does not: a server render before hydration, a locked-down browser, an automated
 * client. Matches `defaultTimeZone` in api/internal/api/host.go.
 *
 * This is a DISPLAY default. The instant is stored as `timestamptz` and is therefore UTC in
 * the database whatever is chosen here.
 */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
}

/** "(GMT+05:30) Asia/Kolkata" — the shape people recognise from every other
 *  scheduling tool. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  const minutes = tzOffsetMinutes(at, timeZone);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `(GMT${sign}${hh}:${mm}) ${timeZone.replace(/_/g, " ")}`;
}

/** How far ahead of UTC `timeZone` is at that instant. Positive is east. */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  return Math.round(zoneOffsetMs(at, timeZone) / 60_000);
}

/** The offset by formatting the instant in the zone and reading the wall clock
 *  back. There is no direct offset API, and this is correct across DST because it
 *  asks about a specific instant rather than about the zone in general. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
  } catch {
    return 0; // unknown zone: treat as UTC rather than throwing into a render
  }

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Some engines render midnight as hour 24.
  const hour = value("hour") % 24;
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );
  return asUtc - at.getTime();
}

/**
 * Turns a wall-clock date and time in a named zone into an absolute instant.
 *
 * "09:00 on 1 October in Asia/Kolkata" is not a moment until the zone is
 * applied, and the API stores instants. Two passes because the first guess can
 * land on the wrong side of a DST transition, where the offset used to correct it
 * is itself the offset from the wrong day.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;

  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  let instant = wallAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    instant = wallAsUtc - zoneOffsetMs(new Date(instant), timeZone);
  }
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** The inverse: split an instant into the date and time inputs for a zone, so
 *  editing a webinar shows the time its host scheduled rather than the viewer's. */
export function instantToZoned(
  iso: string,
  timeZone: string,
): { date: string; time: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: "", time: "" };

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const hour = String(Number(value("hour")) % 24).padStart(2, "0");
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${hour}:${value("minute")}`,
  };
}

/** A Google Calendar "quick add" link, pre-filled with this webinar's details.
 *
 * `dates` is written as the webinar's own wall clock, not UTC — Google reads
 * `YYYYMMDDTHHMMSS` (no trailing `Z`) as local time in whatever zone `ctz`
 * names, so this must NOT convert to the viewer's own zone the way every
 * display formatter above does. `instantToZoned` already does exactly that
 * conversion for the editor, so it is reused here rather than duplicated.
 *
 * No join link in `location`: for a registration-gated webinar there isn't
 * one yet: the only address the API can offer before it exists is the
 * registration page, and each attendee's personal join link is minted at
 * registration and emailed to them, not handed out here. The event still
 * needs a location, so this names what it is instead of pointing at a URL
 * nobody holding this invite can use yet.
 */
export function googleCalendarInviteUrl(webinar: {
  topic: string;
  description: string;
  startsAt: string;
  durationMin: number;
  timeZone: string;
  webinarId: string;
  registrationUrl: string;
}): string {
  const { topic, description, startsAt, durationMin, timeZone, webinarId, registrationUrl } =
    webinar;

  const stamp = (date: string, time: string) =>
    `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;

  const start = instantToZoned(startsAt, timeZone);
  const endsAt = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();
  const end = instantToZoned(endsAt, timeZone);

  const details = [
    description.trim() ? `${description.trim()}\n` : null,
    `Register: ${registrationUrl}`,
    `Webinar ID: ${webinarId}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const query =
    `action=TEMPLATE` +
    `&text=${encodeURIComponent(topic)}` +
    `&dates=${stamp(start.date, start.time)}/${stamp(end.date, end.time)}` +
    `&ctz=${encodeURIComponent(timeZone)}` +
    `&details=${encodeURIComponent(details)}` +
    `&location=${encodeURIComponent("Online Webinar")}`;

  return `https://calendar.google.com/calendar/render?${query}`;
}

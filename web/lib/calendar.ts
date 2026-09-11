/* Calendar export.
 *
 * Two formats, because between them they cover everyone: a Google Calendar URL
 * for people who live in a browser tab, and an .ics file for Outlook, Apple
 * Calendar and everything else.
 *
 * No dependency and no server round trip — an .ics file is a dozen lines of text,
 * and generating it in the browser means the download works before any email
 * infrastructure exists.
 */

export type CalendarEvent = {
  title: string;
  description: string;
  startsAt: string; // RFC3339
  durationMin: number;
  /** The join or registration page, put in the location field so calendar apps
   *  turn it into the clickable "join" affordance. */
  url: string;
};

function endOf(event: CalendarEvent): Date {
  return new Date(new Date(event.startsAt).getTime() + event.durationMin * 60_000);
}

/** "20261001T093000Z" — the compact UTC form both formats want. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${stamp(new Date(event.startsAt))}/${stamp(endOf(event))}`,
    details: `${event.description}\n\n${event.url}`.trim(),
    location: event.url,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Escapes a value for an iCalendar property: commas, semicolons and backslashes
 *  are delimiters there, and a raw newline ends the property. */
function ics(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function icsFile(event: CalendarEvent, uid: string): string {
  // CRLF line endings: RFC 5545 requires them, and Outlook in particular rejects
  // a file that uses bare newlines.
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Webinar Liv//Webinar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ics(uid)}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(new Date(event.startsAt))}`,
    `DTEND:${stamp(endOf(event))}`,
    `SUMMARY:${ics(event.title)}`,
    `DESCRIPTION:${ics(`${event.description}\n\n${event.url}`.trim())}`,
    `URL:${ics(event.url)}`,
    `LOCATION:${ics(event.url)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${ics(event.title)} starts in 15 minutes`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Triggers a download of the .ics without a server or a route.
 *
 *  The object URL is revoked on the next tick rather than immediately: revoking
 *  it in the same frame as the click cancels the download in Safari. */
export function downloadIcs(event: CalendarEvent, uid: string, filename: string): void {
  const blob = new Blob([icsFile(event, uid)], {
    type: "text/calendar;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

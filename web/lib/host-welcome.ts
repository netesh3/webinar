/* The one-time note a new host sees on Webinars.
 *
 * An attendee visit records itself in this browser. The next time that same
 * browser opens Webinars with hosting turned on, the banner points at
 * Attending — the list that used to be their whole home. Dismissing it is
 * permanent here, so a host who has been hosting does not see it, and neither
 * does anyone who dismisses it. Another browser that never opened WatchList
 * has nothing to remember, and Attending still holds the rows. */

const SAW = "webinarliv.saw-attendee";
const DISMISSED = "webinarliv.host-welcome-dismissed";

export const HOST_WELCOME_EVENT = "webinarliv-host-welcome";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* A private window that blocks storage simply never shows the note. */
  }
}

/** Call while this browser is signed in as someone who cannot host yet. */
export function noteAttendeeVisit() {
  if (read(DISMISSED) === "1" || read(SAW) === "1") return;
  write(SAW, "1");
}

export function hostWelcomePending(): boolean {
  return read(SAW) === "1" && read(DISMISSED) !== "1";
}

export function dismissHostWelcome() {
  write(DISMISSED, "1");
  try {
    localStorage.removeItem(SAW);
  } catch {
    /* The dismissed flag is what keeps it from coming back. */
  }
}

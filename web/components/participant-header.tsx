"use client";

import Link from "next/link";
import { useAppConfig } from "./providers";

/* The participant experience's only chrome.
 *
 * Deliberately not a navigation bar. Somebody arriving on a registration link is here for one
 * webinar; they did not come from a catalogue and there is nowhere for them to go. What the
 * shared TopNav offers — Browse webinars, My webinars, Host, sign-in, an account menu — is the
 * host product's navigation, and putting it above a registration form makes the link feel like
 * the front door of an application the participant has no business in.
 *
 * So: no nav links, no account menu — just the operator's name. The brand itself DOES link, the
 * same as TopNav's, but only ever to the public marketing home ("/"). That is not the leak the
 * earlier version of this comment worried about: it is not /browse (the attendee catalogue) and
 * not /host (the dashboard), so it advertises nothing a participant should not already know the
 * product has a homepage. What it buys is the ordinary expectation every visitor arrives with —
 * the logo goes home — which registrants were asking for often enough that omitting it read as
 * broken rather than as a deliberate narrowing.
 *
 * This is a presentation change and it is NOT the access control. A participant is kept out of
 * the host dashboard by middleware.ts and by the API, both of which refuse the URL. This only
 * decides that the page they are allowed to see does not advertise the pages they are not.
 */
export function ParticipantHeader() {
  const { appName } = useAppConfig();

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-brand text-[12px] font-bold text-white">
            {appName.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">{appName}</span>
        </Link>
      </div>
    </header>
  );
}

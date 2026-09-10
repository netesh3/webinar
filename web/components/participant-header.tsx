"use client";

import { useAppConfig } from "./providers";

/* The participant experience's only chrome.
 *
 * Deliberately not a navigation bar. Somebody arriving on a registration link is here for one
 * webinar; they did not come from a catalogue and there is nowhere for them to go. What the
 * shared TopNav offers — Browse webinars, My webinars, Host, sign-in, an account menu — is the
 * host product's navigation, and putting it above a registration form makes the link feel like
 * the front door of an application the participant has no business in.
 *
 * So: the operator's name, and nothing that is a link. The brand is not clickable on purpose —
 * a logo that navigates to a webinar catalogue is the same leak in a friendlier shape.
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
        <span className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-brand text-[12px] font-bold text-white">
            {appName.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">{appName}</span>
        </span>
      </div>
    </header>
  );
}

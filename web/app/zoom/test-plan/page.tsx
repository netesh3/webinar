import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LegalPage, SUPPORT_EMAIL } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Zoom app test plan — Webinar Liv",
  description:
    "Step-by-step test plan for Zoom App Marketplace reviewers of the Webinar Liv Zoom app.",
  alternates: { canonical: "/zoom/test-plan" },
  robots: { index: false, follow: false },
};

const UPDATED = "October 23, 2026";

/* Unlisted test plan for Zoom App Marketplace reviewers. Not in the sitemap.
 * Keep it in step with docs/zoom-marketplace-submission.md and the calls in
 * api/internal/zoom. Never put test credentials here. */

type Shot = {
  /** File in public/zoom/test-plan/. */
  file: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
};

type TestCase = {
  id: string;
  title: string;
  steps: ReactNode[];
  expected: ReactNode;
  note?: ReactNode;
  scopes: string[];
  /** Screenshots from a full dry run on a free (Basic) Zoom account. */
  shots?: Shot[];
};

const W = 1600;

const CASES: TestCase[] = [
  {
    id: "A",
    title: "Authorize the app",
    steps: [
      <>
        Go to <a href="https://webinarliv.com/login">webinarliv.com/login</a> and
        sign in with the Webinar Liv test credentials.
      </>,
      <>
        Open <strong>Settings → Integrations</strong>.
      </>,
      <>
        On the Zoom card, click <strong>Connect Zoom</strong>.
      </>,
      <>
        Sign in to your Zoom test account if asked, review the permissions on
        Zoom&apos;s consent screen, and click <strong>Allow</strong>.
      </>,
    ],
    expected: (
      <>
        You return to Settings → Integrations. The Zoom card shows Zoom as
        connected, with the Zoom account&apos;s email and a{" "}
        <strong>Disconnect</strong> button.
      </>
    ),
    scopes: ["user:read:user"],
    shots: [
      {
        file: "a-integrations.png",
        alt: "Webinar Liv Settings, Integrations tab. The Zoom card under Meetings says Not connected and has a Connect Zoom button.",
        caption: "Settings → Integrations, before connecting.",
        width: W,
        height: 923,
      },
      {
        file: "a-zoom-consent.png",
        alt: "Zoom consent screen: Webinar Liv would like permission to create, update, view and delete meetings and webinars, view a user, add registrants and view participants. Allow and Decline buttons.",
        caption: "Zoom's consent screen.",
        width: W,
        height: 923,
      },
      {
        file: "a-zoom-connected.png",
        alt: "Settings, Integrations tab after authorizing. The Zoom card says Connected, shows the Zoom account webinarliv@gmail.com and a Disconnect button.",
        caption: "Back in Webinar Liv: Zoom connected.",
        width: W,
        height: 923,
      },
    ],
  },
  {
    id: "B",
    title: "Schedule a webinar that runs on a Zoom meeting",
    steps: [
      <>
        Click <strong>Schedule a webinar</strong>.
      </>,
      <>Enter a title and a start time at least 15 minutes from now.</>,
      <>
        Under <strong>Where it runs</strong>, choose <strong>Zoom meeting</strong>.
      </>,
      <>Save the webinar.</>,
      <>
        In another tab, open <a href="https://zoom.us/meeting">zoom.us → Meetings</a>{" "}
        for the same Zoom account.
      </>,
    ],
    expected: (
      <>
        A Zoom meeting with the same title, start time and length appears in
        the Zoom account, with registration turned on. The Webinar Liv webinar
        page says &quot;This session runs in Zoom&quot;.
      </>
    ),
    scopes: ["meeting:write:meeting"],
    shots: [
      {
        file: "b-where-it-runs.png",
        alt: "The Where it runs section of the schedule form, with Zoom meeting selected instead of This app or Zoom webinar.",
        caption: "Where it runs: Zoom meeting.",
        width: W,
        height: 281,
      },
      {
        file: "b-webinar-page.png",
        alt: "The host page of the scheduled webinar Zoom review — test session. It says This session runs in Zoom. Go live opens Zoom as the host. It ends in Zoom. It shows the share link, a Go live button and a Webinar scheduled message.",
        caption: "The webinar in Webinar Liv.",
        width: W,
        height: 923,
      },
      {
        file: "b-zoom-meetings.png",
        alt: "Zoom web portal, Meetings, Upcoming: Zoom review — test session, today 10:30 PM to 11:30 PM.",
        caption: "The same meeting in Zoom.",
        width: W,
        height: 923,
      },
    ],
  },
  {
    id: "C",
    title: "Edit the webinar",
    steps: [
      <>Open the webinar from case B in Webinar Liv and edit it.</>,
      <>Change the title and move the start time, then save.</>,
      <>Refresh the meeting in Zoom.</>,
    ],
    expected: <>The Zoom meeting shows the new title and start time.</>,
    scopes: ["meeting:update:meeting"],
  },
  {
    id: "D",
    title: "Register as an attendee",
    steps: [
      <>
        Copy the webinar&apos;s public registration link (<strong>Share</strong>)
        and open it in a private browser window.
      </>,
      <>Register with any name and an email address you can read.</>,
      <>Check the confirmation page and the confirmation email.</>,
      <>In Zoom, open the meeting and view its registrants.</>,
    ],
    expected: (
      <>
        The confirmation page and email show a personal Zoom join link for
        that person. The person is listed as an approved registrant on the
        Zoom meeting. Zoom&apos;s own registration emails are turned off;
        Webinar Liv sends the confirmation and reminders.
      </>
    ),
    note: (
      <>
        Registering with an email address that is new to Webinar Liv sends a
        &quot;confirm your email&quot; message first. After the attendee opens
        it, the join email with their Zoom link arrives. On a free Zoom
        account that link is the meeting&apos;s shared join link, not a
        personal one (see <a href="#free-zoom">Free (Basic) Zoom accounts</a>).
      </>
    ),
    scopes: ["meeting:write:registrant"],
    shots: [
      {
        file: "d-registration-page.png",
        alt: "Public registration page for Zoom review — test session, with the Register & Join form filled in: name Test Attendee, an email address, country and mobile number.",
        caption: "The public registration page.",
        width: W,
        height: 900,
      },
      {
        file: "d-email-verified.png",
        alt: "Webinar Liv Verify your email page saying Your email is verified. If you registered for a webinar, your join link is on its way to this inbox.",
        caption: "After opening the confirm-your-email message.",
        width: W,
        height: 923,
      },
    ],
  },
  {
    id: "E",
    title: "Go live as host",
    steps: [
      <>Back in Webinar Liv (signed in as the host), open the webinar.</>,
      <>
        Click <strong>Go live</strong>.
      </>,
    ],
    expected: (
      <>
        Webinar Liv reads the meeting from Zoom to get a fresh host start link,
        and Zoom opens in a new tab, starting the meeting with you as host.
      </>
    ),
    scopes: ["meeting:read:meeting"],
    shots: [
      {
        file: "e-host-in-zoom.png",
        alt: "Zoom meeting window with the host, Webinar liv, in the meeting after clicking Go live.",
        caption: "The host in the Zoom meeting.",
        width: W,
        height: 839,
      },
    ],
  },
  {
    id: "F",
    title: "Attend, leave and end the meeting",
    steps: [
      <>
        In the private window, open the registrant&apos;s personal Zoom join link
        from case D and join the meeting.
      </>,
      <>After a minute or two, leave the meeting as the registrant.</>,
      <>As host, end the meeting for all in Zoom.</>,
      <>Wait about a minute, then open the webinar and its attendance page in Webinar Liv.</>,
    ],
    expected: (
      <>
        Webinar Liv marks the webinar <strong>Completed</strong>. The attendance
        page lists the participants with join and leave times and time
        attended. Joins and leaves are recorded from the{" "}
        <code>meeting.participant_joined</code> and{" "}
        <code>meeting.participant_left</code> events. On{" "}
        <code>meeting.ended</code>, Webinar Liv reads the past-participants
        list to complete the report.
      </>
    ),
    note: (
      <>
        On a free Zoom account, attendance comes from the live participant
        events only, and people who join through the shared link without an
        email show up as walk-ins (see{" "}
        <a href="#free-zoom">Free (Basic) Zoom accounts</a>).
      </>
    ),
    scopes: ["meeting:read:participant", "meeting:read:list_past_participants"],
    shots: [
      {
        file: "f-attendee-join.png",
        alt: "Zoom's Join meeting page, opened from the attendee's join link, with Join from Zoom Workplace app and Join from browser buttons.",
        caption: "The attendee's join link opens Zoom.",
        width: W,
        height: 1000,
      },
      {
        file: "f-attendee-in-zoom.png",
        alt: "Zoom meeting window from the attendee's side: Test Attendee and the host, Webinar liv, are both in the meeting.",
        caption: "The attendee in the Zoom meeting.",
        width: W,
        height: 839,
      },
      {
        file: "f-results.png",
        alt: "Webinar Liv Results for Zoom review — test session after the meeting ended in Zoom. Status Completed, 2 registered, 1 attended, 5 minute average watch time.",
        caption: "Results after the meeting ended in Zoom.",
        width: W,
        height: 839,
      },
    ],
  },
  {
    id: "G",
    title: "Repeat with a Zoom webinar (Webinars add-on)",
    steps: [
      <>Only if the Zoom test account has the Zoom Webinars add-on.</>,
      <>
        Repeat cases B to F, choosing <strong>Zoom webinar</strong> under{" "}
        <strong>Where it runs</strong>.
      </>,
      <>
        Check the results in <a href="https://zoom.us/webinar/list">zoom.us → Webinars</a>.
      </>,
    ],
    expected: (
      <>
        The same results as B to F, on a Zoom webinar: created, updated,
        registrant added with a personal link, started as host from Go live,
        and attendance recorded from the <code>webinar.*</code> events and
        the past-participants list.
      </>
    ),
    scopes: [
      "webinar:write:webinar",
      "webinar:update:webinar",
      "webinar:write:registrant",
      "webinar:read:webinar",
      "webinar:read:participant",
      "webinar:read:list_past_participants",
    ],
  },
  {
    id: "H",
    title: "Delete a webinar that runs on Zoom",
    steps: [
      <>Schedule another webinar on Zoom (meeting, or webinar if available), as in case B.</>,
      <>Open it in Webinar Liv and delete it.</>,
      <>Refresh the Meetings (or Webinars) list in Zoom.</>,
    ],
    expected: <>The matching Zoom meeting or webinar is deleted from the Zoom account.</>,
    scopes: ["meeting:delete:meeting", "webinar:delete:webinar"],
    shots: [
      {
        file: "h-delete-confirm.png",
        alt: "Webinar Liv confirmation dialog: Delete this webinar and its records? with Cancel and Delete this webinar buttons.",
        caption: "Deleting a webinar in Webinar Liv.",
        width: W,
        height: 839,
      },
      {
        file: "h-webinar-list.png",
        alt: "Webinar Liv webinar list after the delete, showing No webinars yet.",
        caption: "The webinar list after the delete.",
        width: W,
        height: 839,
      },
      {
        file: "h-zoom-before.png",
        alt: "Zoom Meetings, Upcoming, before the delete: Zoom review — test session today and Zoom review — delete test tomorrow at 11:43 PM.",
        caption: "Zoom before deleting “Zoom review — delete test”.",
        width: W,
        height: 923,
      },
      {
        file: "h-zoom-after.png",
        alt: "Zoom Meetings, Upcoming, after the delete: only Zoom review — test session is listed; Zoom review — delete test is gone.",
        caption: "Zoom after: the meeting is removed.",
        width: W,
        height: 923,
      },
    ],
  },
  {
    id: "I",
    title: "Disconnect in Webinar Liv",
    steps: [
      <>
        Open <strong>Settings → Integrations</strong>.
      </>,
      <>
        On the Zoom card, click <strong>Disconnect</strong> and confirm.
      </>,
    ],
    expected: (
      <>
        The card shows <strong>Connect Zoom</strong> again. Webinar Liv revokes
        the token with Zoom (<code>POST /oauth/revoke</code>) and deletes the
        stored token.
      </>
    ),
    scopes: [],
    shots: [
      {
        file: "i-before.png",
        alt: "Webinar Liv Settings, Integrations, before disconnecting: the sidebar lists Zoom and Email under Integrations, 2 connected.",
        caption: "Before: Zoom listed as connected.",
        width: W,
        height: 839,
      },
      {
        file: "i-after.png",
        alt: "Webinar Liv Settings, Integrations, after disconnecting: the sidebar lists only Email under Integrations, 1 connected.",
        caption: "After: Zoom no longer connected.",
        width: W,
        height: 839,
      },
    ],
  },
  {
    id: "J",
    title: "Remove the app from the Zoom App Marketplace",
    steps: [
      <>Connect Zoom again, as in case A.</>,
      <>
        Sign in to the{" "}
        <a href="https://marketplace.zoom.us/user/installed">Zoom App Marketplace</a>{" "}
        and open <strong>Manage → Added Apps</strong>.
      </>,
      <>
        Find Webinar Liv and click <strong>Remove</strong>.
      </>,
      <>Reload Settings → Integrations in Webinar Liv.</>,
    ],
    expected: (
      <>
        Zoom sends the <code>app_deauthorized</code> event, Webinar Liv deletes
        the stored connection, and the Zoom card shows{" "}
        <strong>Connect Zoom</strong> again.
      </>
    ),
    scopes: [],
  },
];

const SCOPES: { scope: string; use: string; cases: string }[] = [
  { scope: "user:read:user", use: "GET /users/me", cases: "A" },
  { scope: "meeting:write:meeting", use: "POST /users/me/meetings", cases: "B" },
  { scope: "meeting:update:meeting", use: "PATCH /meetings/{meetingId}", cases: "C" },
  { scope: "meeting:write:registrant", use: "POST /meetings/{meetingId}/registrants", cases: "D" },
  { scope: "meeting:read:meeting", use: "GET /meetings/{meetingId}", cases: "E" },
  {
    scope: "meeting:read:participant",
    use: "meeting.participant_joined and meeting.participant_left events",
    cases: "F",
  },
  {
    scope: "meeting:read:list_past_participants",
    use: "GET /past_meetings/{meetingId}/participants",
    cases: "F",
  },
  { scope: "meeting:delete:meeting", use: "DELETE /meetings/{meetingId}", cases: "H" },
  { scope: "webinar:write:webinar", use: "POST /users/me/webinars", cases: "G" },
  { scope: "webinar:update:webinar", use: "PATCH /webinars/{webinarId}", cases: "G" },
  { scope: "webinar:write:registrant", use: "POST /webinars/{webinarId}/registrants", cases: "G" },
  { scope: "webinar:read:webinar", use: "GET /webinars/{webinarId}", cases: "G" },
  {
    scope: "webinar:read:participant",
    use: "webinar.participant_joined and webinar.participant_left events",
    cases: "G",
  },
  {
    scope: "webinar:read:list_past_participants",
    use: "GET /past_webinars/{webinarId}/participants",
    cases: "G",
  },
  { scope: "webinar:delete:webinar", use: "DELETE /webinars/{webinarId}", cases: "H" },
];

function Shots({ shots }: { shots: Shot[] }) {
  return (
    <div className="legal-shots">
      {shots.map((s) => {
        const src = `/zoom/test-plan/${s.file}`;
        return (
          <figure key={s.file}>
            <a href={src} target="_blank" rel="noopener">
              {/* eslint-disable-next-line @next/next/no-img-element -- static
                  screenshots that link to the full-size file. */}
              <img src={src} alt={s.alt} width={s.width} height={s.height} loading="lazy" />
            </a>
            <figcaption>{s.caption}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function ScopeList({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return <>none</>;
  return (
    <>
      {scopes.map((s, i) => (
        <span key={s}>
          {i > 0 && ", "}
          <code>{s}</code>
        </span>
      ))}
    </>
  );
}

export default function ZoomTestPlanPage() {
  return (
    <LegalPage title="Zoom app test plan" updated={UPDATED}>
      <p>
        For Zoom App Marketplace reviewers. This plan walks through authorizing
        the Webinar Liv Zoom app, every scope it uses, and everything an end
        user sees.
      </p>

      <h2>Overview</h2>
      <p>
        Webinar Liv is a webinar platform. With the Zoom app, a host runs a
        webinar as a <strong>Zoom meeting</strong> or a{" "}
        <strong>Zoom webinar</strong> on their own Zoom account. Webinar Liv
        creates, updates and deletes that Zoom session, adds each registrant so
        they get a personal join link, opens Zoom as host on Go live, and
        builds the attendance report when the session ends. It only touches
        sessions created from Webinar Liv.
      </p>
      <p>
        Production (https://webinarliv.com) authorizes with the app&apos;s{" "}
        <strong>Production Client ID</strong>. The OAuth redirect is{" "}
        <code>https://webinarliv.com/api/host/zoom/callback</code> and events
        go to <code>https://webinarliv.com/api/webhooks/zoom</code>.
      </p>

      <h3>Prerequisites</h3>
      <ul>
        <li>The Webinar Liv test account (see Test credentials).</li>
        <li>
          A Zoom test account on Pro or above. Registration, which gives each
          registrant a personal join link, needs a paid Zoom plan.
        </li>
        <li>For case G only: the Zoom Webinars add-on on that Zoom account.</li>
        <li>A second browser or a private window to act as the attendee.</li>
      </ul>

      <h3 id="free-zoom">Free (Basic) Zoom accounts</h3>
      <p>
        The screenshots on this page are from a dry run on a free (Basic) Zoom
        account. The flow works there too, with these differences:
      </p>
      <ul>
        <li>
          Zoom does not allow per-registrant links for meetings on a free
          account (&quot;Only available for paid users&quot;), so attendees
          get the meeting&apos;s shared join link instead. Zoom Webinars need
          the Webinar add-on.
        </li>
        <li>
          Zoom&apos;s past-participants report API is not available on a free
          account, so attendance comes from Zoom&apos;s live participant
          events.
        </li>
        <li>
          Attendees who join through the shared link without an email show up
          as walk-ins rather than matched to their registration.
        </li>
      </ul>
      <p>Click any screenshot to open it full size.</p>

      <h2>Test credentials</h2>
      <p>
        The Webinar Liv sign-in email and password are provided in the
        submission form&apos;s <strong>Test Credentials</strong> field. They are
        not published on this page. That account has Zoom enabled. Use your own
        Zoom test account when Zoom asks you to sign in.
      </p>

      <h2>Test cases</h2>
      {CASES.map((c) => (
        <section key={c.id} id={`case-${c.id.toLowerCase()}`}>
          <h3>
            {c.id}. {c.title}
          </h3>
          <ol>
            {c.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <p>
            <strong>Expected:</strong> {c.expected}
          </p>
          {c.note && (
            <p>
              <strong>Note:</strong> {c.note}
            </p>
          )}
          <p>
            <strong>Scopes exercised:</strong> <ScopeList scopes={c.scopes} />
          </p>
          {c.shots && <Shots shots={c.shots} />}
        </section>
      ))}

      <h2>Scopes</h2>
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Zoom API call or event</th>
            <th>Case</th>
          </tr>
        </thead>
        <tbody>
          {SCOPES.map((s) => (
            <tr key={s.scope}>
              <td>
                <code>{s.scope}</code>
              </td>
              <td>
                <code>{s.use}</code>
              </td>
              <td>{s.cases}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Revoking the token on disconnect (<code>POST /oauth/revoke</code>) and
        the <code>app_deauthorized</code> event need no scope. Event
        subscriptions: <code>meeting.participant_joined</code>,{" "}
        <code>meeting.participant_left</code>, <code>meeting.ended</code>,{" "}
        <code>webinar.participant_joined</code>,{" "}
        <code>webinar.participant_left</code>, <code>webinar.ended</code>.
      </p>

      <h2>Data handling</h2>
      <ul>
        <li>
          Stored: the Zoom user and account id and email; the refresh token,
          encrypted with AES-256-GCM; the id, join link and start link of
          sessions created from Webinar Liv; and, for those sessions only,
          attendee names, emails and join and leave times.
        </li>
        <li>
          Not accessed: other meetings, recordings, chat, contacts or account
          settings. No admin scopes.
        </li>
        <li>
          Every webhook is checked against Zoom&apos;s <code>x-zm-signature</code>{" "}
          before it is read.
        </li>
        <li>Zoom data is not shared or sold.</li>
        <li>
          Disconnecting or removing the app deletes the stored token. Hosts can
          delete a webinar or their account to delete its data.
        </li>
      </ul>
      <p>
        Full details are in the <Link href="/privacy">Privacy Policy</Link>.
        End-user instructions are on the{" "}
        <Link href="/integrations/zoom">Zoom integration</Link> page.
      </p>

      <h2 id="support">Support</h2>
      <p>
        Questions during review: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}

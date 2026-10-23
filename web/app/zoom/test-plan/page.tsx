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

type TestCase = {
  id: string;
  title: string;
  steps: ReactNode[];
  expected: ReactNode;
  scopes: string[];
};

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
    scopes: ["meeting:write:registrant"],
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
        Webinar Liv marks the webinar <strong>Ended</strong>. The attendance
        page lists the participants with join and leave times and time
        attended. Joins and leaves are recorded from the{" "}
        <code>meeting.participant_joined</code> and{" "}
        <code>meeting.participant_left</code> events. On{" "}
        <code>meeting.ended</code>, Webinar Liv reads the past-participants
        list to complete the report.
      </>
    ),
    scopes: ["meeting:read:participant", "meeting:read:list_past_participants"],
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
          <p>
            <strong>Scopes exercised:</strong> <ScopeList scopes={c.scopes} />
          </p>
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

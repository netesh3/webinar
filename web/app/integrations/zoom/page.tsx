import type { Metadata } from "next";
import { LEGAL_UPDATED, legalDateLabel } from "@/lib/seo";
import Link from "next/link";
import { LegalPage, SUPPORT_EMAIL } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Zoom integration — Webinar Liv",
  description:
    "How to connect Zoom to Webinar Liv, run a webinar on Zoom, and remove the app.",
  alternates: { canonical: "/integrations/zoom" },
};

// Also the sitemap's lastModified; change the date in lib/seo.ts.
const UPDATED = legalDateLabel(LEGAL_UPDATED.zoom);

/* The documentation page the Zoom App Marketplace links to: adding, using, and
 * removing the app. Keep it in step with docs/zoom-marketplace-submission.md. */
export default function ZoomIntegrationPage() {
  return (
    <LegalPage title="Zoom integration" updated={UPDATED}>
      <p>
        Webinar Liv can run a webinar as a <strong>Zoom meeting</strong> or a{" "}
        <strong>Zoom webinar</strong> on your own Zoom account. Registration,
        reminders, WhatsApp and email follow-up, and attendance reports stay in
        Webinar Liv; the live session itself happens in Zoom.
      </p>

      <h2>What you need</h2>
      <ul>
        <li>A Webinar Liv host account on a plan that includes Zoom</li>
        <li>
          A licensed Zoom account (Pro or above). Personal join links for each
          registrant need registration, which Zoom offers on paid plans. Zoom
          webinars need the Zoom Webinars add-on.
        </li>
      </ul>

      <h2>Adding the app</h2>
      <ol>
        <li>Sign in to Webinar Liv and open <strong>Settings → Integrations</strong>.</li>
        <li>On the Zoom card, click <strong>Connect Zoom</strong>.</li>
        <li>Sign in to Zoom if asked, review the permissions, and click <strong>Allow</strong>.</li>
        <li>You return to Settings with Zoom shown as connected.</li>
      </ol>

      <h2>Using it</h2>
      <ol>
        <li>
          Schedule a webinar. Under <strong>Where it runs</strong>, choose{" "}
          <strong>Zoom meeting</strong> or <strong>Zoom webinar</strong>.
        </li>
        <li>
          Save. Webinar Liv creates the meeting or webinar on your Zoom account
          with the same title, time, and length. Editing or deleting the webinar
          in Webinar Liv updates or deletes it in Zoom.
        </li>
        <li>
          Each registrant is added to the Zoom session and gets their own Zoom
          join link in their confirmation and reminders.
        </li>
        <li>
          At start time, click <strong>Go live</strong>. Zoom opens in a new tab
          with you as host.
        </li>
        <li>
          When the session ends in Zoom, Webinar Liv marks the webinar ended and
          shows who attended and for how long.
        </li>
      </ol>
      <p>
        If your Zoom plan cannot do what the webinar needs, the webinar stays on
        Webinar Liv&apos;s own room and you are told why.
      </p>

      <h2>Permissions and data</h2>
      <p>
        Webinar Liv only touches meetings and webinars you create from Webinar
        Liv: it creates, updates, and deletes them, adds their registrants, and
        reads who attended. It does not read your other meetings, recordings,
        chat, or contacts. Details are in the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Removing the app</h2>
      <ul>
        <li>
          In Webinar Liv: open <strong>Settings → Integrations</strong>, click{" "}
          <strong>Disconnect</strong> on the Zoom card, and confirm. This
          revokes Webinar Liv&apos;s access and deletes the stored token.
        </li>
        <li>
          Or in Zoom: sign in to the{" "}
          <a href="https://marketplace.zoom.us/user/installed">Zoom App Marketplace</a>,
          open <strong>Manage → Added Apps</strong>, find Webinar Liv, and click{" "}
          <strong>Remove</strong>. Zoom tells us, and we delete the connection.
        </li>
      </ul>
      <p>
        Zoom meetings already created stay in your Zoom account. Webinars set to
        run on Zoom need Zoom connected again, or can be switched back to
        Webinar Liv&apos;s own room. Attendance already recorded stays with the
        webinar until you delete it. To delete your data, delete the webinar or
        your account, or email us.
      </p>

      <h2 id="support">Support</h2>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}

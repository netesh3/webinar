import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalPage,
  SUPPORT_EMAIL,
} from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy — Webinar Liv",
  description:
    "How Webinar Liv collects, uses, and shares personal data for webinar hosting and attendance.",
};

const UPDATED = "September 21, 2026";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <p>
        This Privacy Policy describes how <strong>Webinar Liv</strong>{" "}
        (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) handles
        information when you use webinarliv.com and related services (the
        &ldquo;Service&rdquo;). It is written for clarity in a standard SaaS
        style and is not a substitute for legal advice.
      </p>

      <h2>1. Who we are</h2>
      <p>
        Webinar Liv is a webinar hosting platform at{" "}
        <a href="https://webinarliv.com">https://webinarliv.com</a>. For privacy
        questions, contact{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>2. Information we collect</h2>
      <h3>Account and profile</h3>
      <p>
        When you create an account or sign in, we collect information such as
        your name, email address, and password (stored as a secure hash). If you
        continue with Google, we receive profile details Google shares with us
        (typically name, email, and a stable Google account identifier), subject
        to your Google account settings and Google&apos;s policies.
      </p>
      <h3>Webinar and registration data</h3>
      <p>
        Hosts provide webinar titles, schedules, descriptions, and settings.
        Attendees and panelists may provide registration details (for example
        name and email), join keys, and optional guest identifiers. We also
        store engagement content you create in a session, such as chat messages,
        Q&amp;A questions, poll responses, and raise-hand or reaction signals.
      </p>
      <h3>Media and recordings</h3>
      <p>
        During a live session, audio, video, and screen-share streams are
        transmitted so participants can see and hear each other. If a host
        starts a recording, we process and store that recording and related
        metadata so the host can access it later. Camera and microphone access
        is controlled by your browser; we do not receive media when you have not
        granted permission or are not connected to a room.
      </p>
      <h3>Technical and session data</h3>
      <p>
        We use cookies and similar technologies for authentication and session
        continuity (for example an httpOnly session cookie after sign-in). We
        may also collect standard technical logs such as IP address, user agent,
        approximate region, device or browser type, and request timestamps to
        operate, secure, and debug the Service.
      </p>

      <h2>3. How we use information</h2>
      <ul>
        <li>Provide, operate, and improve webinar scheduling, registration, and live sessions</li>
        <li>Authenticate users, maintain sessions, and enforce access controls (including admit queues and host permissions)</li>
        <li>Deliver engagement features (chat, Q&amp;A, polls, reactions) and attendance or export features hosts use</li>
        <li>Process and store session recordings when a host enables recording</li>
        <li>Send transactional messages related to the Service (for example account or session notices)</li>
        <li>Monitor reliability and security, prevent abuse, and comply with law</li>
      </ul>

      <h2>4. Google OAuth</h2>
      <p>
        If you choose Google sign-in, authentication is handled by Google and
        our identity provider. We receive the account information needed to
        create or link your Webinar Liv account. We do not receive your Google
        password. Your use of Google is also governed by Google&apos;s privacy
        policy. You can disconnect Google access through your Google account
        settings; you may still need a password or another method to sign in
        afterward.
      </p>

      <h3>YouTube Live (optional)</h3>
      <p>
        Hosts may connect a YouTube channel so Webinar Liv can create a live
        broadcast and push the session mix to YouTube. That grant uses Google
        OAuth with the YouTube scope and is separate from Google sign-in. We
        store a refresh token on the host account, plus the channel name and a
        reusable encoder id. We use this access only to create, bind, and
        complete lives you start from Webinar Liv, and to show you the watch
        link. We do not use it to read your private videos, manage comments, or
        advertise. You can disconnect YouTube in Account settings, which
        revokes the grant and deletes the stored token.
      </p>
      <p>
        Use of YouTube is also subject to{" "}
        <a href="https://www.youtube.com/t/terms">YouTube&apos;s Terms of Service</a>{" "}
        and the{" "}
        <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
        Webinar Liv&apos;s use of information received from Google APIs adheres
        to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>5. Live media (LiveKit)</h2>
      <p>
        Real-time audio and video are delivered through LiveKit infrastructure.
        Media is routed through LiveKit servers so participants in a room can
        connect. Media handling is limited to operating the live session and,
        when enabled by a host, producing recordings. Do not share sensitive
        information in a webinar you would not want other participants or the
        host to see or hear.
      </p>

      <h2>6. Service providers and hosting</h2>
      <p>
        We use trusted processors to run the Service, including:
      </p>
      <ul>
        <li>
          <strong>Cloudflare</strong> — frontend hosting and edge delivery
          (Workers)
        </li>
        <li>
          <strong>Google Cloud Run</strong> — application API hosting
        </li>
        <li>
          <strong>Supabase</strong> — managed Postgres database and related auth
          infrastructure where configured
        </li>
        <li>
          <strong>LiveKit</strong> — real-time media transport
        </li>
        <li>
          <strong>Google</strong> — optional OAuth sign-in and, if a host
          connects YouTube, the YouTube Data API for live broadcasts
        </li>
      </ul>
      <p>
        These providers process data on our behalf under their terms and only as
        needed to provide the Service. We do not sell your personal information.
      </p>

      <h2>7. Cookies and similar technologies</h2>
      <p>
        We use essential cookies for sign-in sessions and product preferences
        (for example UI mode). These are required for the Service to function as
        designed. We do not use third-party advertising cookies on the core
        product experience described here.
      </p>

      <h2>8. Sharing</h2>
      <p>
        We share information with other participants as needed for the webinar
        you join (for example display name in a room, chat, or Q&amp;A). Hosts
        and organizers of a webinar you register for or attend may receive your
        registration and attendance details. We may disclose information if
        required by law, to protect rights and safety, or in connection with a
        business transfer (with notice where appropriate).
      </p>

      <h2>9. Retention</h2>
      <p>
        We retain account, webinar, registration, and engagement data for as
        long as needed to provide the Service and for legitimate operational,
        security, and legal purposes. Cloud recordings are stored for{" "}
        <strong>30 days</strong> from the time they are created, then deleted
        automatically from our storage. Download a recording to your own
        computer if you need it beyond that window. Hosts can also delete a
        webinar or recording sooner; that removes associated content subject to
        backup and log retention windows. Recordings saved only on a host&apos;s
        device are never stored by us.
      </p>

      <h2>10. Security</h2>
      <p>
        We use industry-standard measures such as encrypted transport (HTTPS /
        WSS), hashed passwords, and access controls. No method of transmission
        or storage is completely secure; please use strong credentials and treat
        join links carefully.
      </p>

      <h2>11. Your choices</h2>
      <ul>
        <li>Update account details where the product allows</li>
        <li>Sign out to end an authenticated browser session</li>
        <li>Request account or data deletion by emailing {SUPPORT_EMAIL}</li>
        <li>Control camera, microphone, and screen share from your browser and in-room controls</li>
        <li>Manage Google account permissions for third-party apps in your Google settings</li>
      </ul>

      <h2>12. Children</h2>
      <p>
        The Service is not directed to children under 13 (or the minimum age
        required in your jurisdiction). We do not knowingly collect personal
        information from children. If you believe a child has provided data,
        contact us and we will take appropriate steps.
      </p>

      <h2>13. International processing</h2>
      <p>
        We and our providers may process data in the United States and other
        countries where infrastructure is located. If you access the Service
        from elsewhere, you understand that your information may be transferred
        to those locations.
      </p>

      <h2>14. Changes</h2>
      <p>
        We may update this Policy from time to time. We will post the revised
        version on this page and update the &ldquo;Last updated&rdquo; date.
        Continued use of the Service after changes means you accept the updated
        Policy.
      </p>

      <h2>15. Contact</h2>
      <p>
        Questions about privacy:{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        <br />
        Related: <Link href="/terms">Terms of Service</Link>
      </p>
    </LegalPage>
  );
}

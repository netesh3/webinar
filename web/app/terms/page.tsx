import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalPage,
  SUPPORT_EMAIL,
} from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service — Webinar Liv",
  description:
    "Terms governing use of the Webinar Liv webinar hosting platform at webinarliv.com.",
};

const UPDATED = "September 11, 2026";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated={UPDATED}>
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of{" "}
        <strong>Webinar Liv</strong> at{" "}
        <a href="https://webinarliv.com">https://webinarliv.com</a> and related
        services (the &ldquo;Service&rdquo;). By creating an account, hosting or
        joining a webinar, or otherwise using the Service, you agree to these
        Terms. This is standard SaaS-style product language and is not a
        substitute for legal advice.
      </p>

      <h2>1. The Service</h2>
      <p>
        Webinar Liv lets organizers schedule and host webinars with features such
        as registration, admit controls, live audio/video and screen share,
        chat, Q&amp;A, polls, reactions, attendance exports, and optional
        session recording. Features available to you depend on your role
        (host, panelist, attendee, or guest) and how a given webinar is
        configured.
      </p>

      <h2>2. Eligibility and accounts</h2>
      <p>
        You must be able to form a binding contract in your jurisdiction to use
        the Service. You are responsible for the accuracy of account information
        and for keeping credentials confidential. You may sign in with email and
        password or with Google OAuth where enabled. You are responsible for
        activity under your account.
      </p>

      <h2>3. Hosts, attendees, and content</h2>
      <p>
        Hosts are responsible for webinars they create, including who may join,
        what attendees are told about recording or data collection, and content
        shared on stage or in engagement tools. Attendees and guests agree to
        follow host instructions and applicable law. You retain ownership of
        content you submit, and you grant Webinar Liv a limited license to host,
        transmit, store, and display that content as needed to operate the
        Service (including LiveKit media transport and, when enabled, recordings).
      </p>
      <p>
        You must not upload or stream unlawful, infringing, harassing, or
        harmful content; attempt to disrupt the Service; probe or abuse other
        users&apos; data; or use the Service to spam or distribute malware.
      </p>

      <h2>4. Media, recordings, and privacy expectations</h2>
      <p>
        Live sessions use real-time media infrastructure (LiveKit). If a host
        enables recording, audio/video and related session activity may be
        captured and stored for the host. Assume that other participants and the
        host can see or hear what you share. Our handling of personal data is
        described in the <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>5. Acceptable use</h2>
      <ul>
        <li>Do not violate law or third-party rights</li>
        <li>Do not attempt unauthorized access to accounts, webinars, or systems</li>
        <li>Do not interfere with Service availability or security</li>
        <li>Do not misuse join links, passcodes, or admit queues to harass others</li>
        <li>Do not reverse engineer the Service except where permitted by law</li>
      </ul>
      <p>
        We may suspend or terminate access for violations or to protect the
        Service and its users.
      </p>

      <h2>6. Third-party services</h2>
      <p>
        The Service depends on third-party infrastructure, including Cloudflare
        (frontend), Google Cloud Run (API), Supabase (database / auth where
        configured), LiveKit (media), and Google (optional sign-in). Your use of
        those providers may also be subject to their terms. We are not
        responsible for outages or changes outside our reasonable control.
      </p>

      <h2>7. Availability and changes</h2>
      <p>
        We aim for reliable operation but do not guarantee uninterrupted or
        error-free Service. We may modify, suspend, or discontinue features with
        or without notice. We may update these Terms by posting a revised
        version on this page; continued use after the update constitutes
        acceptance.
      </p>

      <h2>8. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
        AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED,
        INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
        NON-INFRINGEMENT, TO THE MAXIMUM EXTENT PERMITTED BY LAW.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, WEBINAR LIV AND ITS OPERATORS
        WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
        PUNITIVE DAMAGES, OR FOR LOST PROFITS, DATA, OR GOODWILL, ARISING FROM
        YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM RELATING TO
        THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID US
        FOR THE SERVICE IN THE THREE MONTHS BEFORE THE CLAIM OR (B) USD $50 IF
        YOU HAVE NOT PAID US.
      </p>

      <h2>10. Indemnity</h2>
      <p>
        You agree to indemnify and hold harmless Webinar Liv and its operators
        from claims arising out of your content, your webinars, or your misuse
        of the Service, to the extent permitted by law.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may stop using the Service at any time. You may request account
        deletion by contacting{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We may suspend
        or delete accounts that violate these Terms or that have been inactive.
        Provisions that by nature should survive (including ownership,
        disclaimers, and limitations) will survive termination.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These Terms are governed by the laws applicable in the jurisdiction
        where the Service operator principally resides, without regard to
        conflict-of-law rules, except where mandatory local consumer law
        provides otherwise. Courts in that jurisdiction will have exclusive
        venue, subject to mandatory local rights.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions about these Terms:{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        <br />
        Related: <Link href="/privacy">Privacy Policy</Link>
      </p>
    </LegalPage>
  );
}

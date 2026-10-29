import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";
import { CONTACT, CONTACT_LIST } from "@/lib/contact";
import { SocialLinks } from "@/components/marketing/social-links";
import { CONTACT_UPDATED, legalDateLabel } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact — Webinar Liv",
  description:
    "Get in touch with Webinar Liv: email support, billing, partnerships, security or privacy, or find us on LinkedIn, Instagram, Facebook, YouTube and X.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <LegalPage title="Contact us" updated={legalDateLabel(CONTACT_UPDATED)}>
      <p>
        Questions about Webinar Liv, your account, a webinar or billing? Email the address that
        fits below and we&apos;ll get back to you. They all reach the same team; the right one
        gets you to the right person sooner.
      </p>
      <ul>
        {CONTACT_LIST.map((c) => (
          <li key={c.key}>
            <strong>{c.label}</strong>: <a href={`mailto:${CONTACT[c.key]}`}>{CONTACT[c.key]}</a>, for {c.for}
          </li>
        ))}
      </ul>
      <h2>Follow Webinar Liv</h2>
      <p>Product updates, tutorials and tips for running better webinars:</p>
      <SocialLinks withLabels className="contact-social" />
    </LegalPage>
  );
}

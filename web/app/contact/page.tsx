import type { Metadata } from "next";
import { LegalPage, SUPPORT_EMAIL } from "@/components/marketing/legal-page";
import { SocialLinks } from "@/components/marketing/social-links";
import { CONTACT_UPDATED, legalDateLabel } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact — Webinar Liv",
  description: "Get in touch with Webinar Liv: email support, or find us on LinkedIn, Instagram, Facebook, YouTube and X.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <LegalPage title="Contact us" updated={legalDateLabel(CONTACT_UPDATED)}>
      <p>
        Questions about Webinar Liv, your account, a webinar or billing? Email us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we&apos;ll get back to you.
      </p>
      <h2>Follow Webinar Liv</h2>
      <p>Product updates, tutorials and tips for running better webinars:</p>
      <SocialLinks withLabels className="contact-social" />
    </LegalPage>
  );
}

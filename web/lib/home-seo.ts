import type { Metadata } from "next";

/** Search metadata for the marketing homepage, shared by / and /home so the
 *  alias points Google at / instead of being indexed as a second page. */

const TITLE = "Webinar Liv — Webinar platform for coaches, teachers & course creators";
const DESCRIPTION =
  "Host live webinars from the browser with WhatsApp and email reminders, polls, quizzes, Q&A, recording, and a 0–100 engagement score for every attendee. No download for your audience.";

export const homeMetadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    siteName: "Webinar Liv",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export function homeJsonLd(origin: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "Webinar Liv",
        url: `${origin}/`,
        logo: `${origin}/brand/mark.png`,
        email: "support@webinarliv.com",
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "Webinar Liv",
        url: `${origin}/`,
        publisher: { "@id": `${origin}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        name: "Webinar Liv",
        url: `${origin}/`,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web browser",
        description: DESCRIPTION,
        publisher: { "@id": `${origin}/#organization` },
      },
    ],
  };
}

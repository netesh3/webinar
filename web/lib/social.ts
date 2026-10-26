/* Webinar Liv's social profiles: the footer of every marketing, blog and legal page, and
 * /contact. One list, so a changed handle is changed once (2026-10-27). */
export type SocialNetwork = "linkedin" | "instagram" | "facebook" | "youtube" | "x";

export type SocialLink = { network: SocialNetwork; label: string; href: string };

export const SOCIAL_LINKS: readonly SocialLink[] = [
  { network: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/company/webinarliv" },
  { network: "instagram", label: "Instagram", href: "https://www.instagram.com/webinarliv/" },
  { network: "facebook", label: "Facebook", href: "https://www.facebook.com/webinarliv" },
  { network: "youtube", label: "YouTube", href: "https://www.youtube.com/@Webinarliv" },
  { network: "x", label: "X", href: "https://x.com/webinarliv" },
];

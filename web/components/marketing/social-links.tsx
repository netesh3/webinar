import { FacebookIcon, InstagramIcon, LinkedInIcon, XIcon, YouTubeIcon } from "@/components/icons";
import { SOCIAL_LINKS, type SocialNetwork } from "@/lib/social";

const ICONS: Record<SocialNetwork, typeof LinkedInIcon> = {
  linkedin: LinkedInIcon,
  instagram: InstagramIcon,
  facebook: FacebookIcon,
  youtube: YouTubeIcon,
  x: XIcon,
};

/** Webinar Liv's profiles as icon links (lib/social.ts). `withLabels` adds the network's
 *  name beside each icon, for /contact; the footer shows icons only. */
export function SocialLinks({ withLabels = false, className = "" }: { withLabels?: boolean; className?: string }) {
  return (
    <ul className={`social-links ${withLabels ? "social-links-labelled" : ""} ${className}`.trim()} aria-label="Webinar Liv on social media">
      {SOCIAL_LINKS.map((s) => {
        const I = ICONS[s.network];
        return (
          <li key={s.network}>
            <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={withLabels ? undefined : `Webinar Liv on ${s.label}`}>
              <I aria-hidden width={18} height={18} />
              {withLabels && <span>{s.label}</span>}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

import { HostPortalFrame } from "@/components/host-portal-frame";

/* The host portal's chrome: the top nav, and a padded column for every page. */

export default function HostPortalLayout({ children }: LayoutProps<"/host">) {
  return <HostPortalFrame>{children}</HostPortalFrame>;
}

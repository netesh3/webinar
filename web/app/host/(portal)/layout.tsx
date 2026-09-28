import { HostPortalFrame } from "@/components/host-portal-frame";

/* The host portal's chrome: top nav, and a padded column for every page except
 * Messages, which fills the window. */

export default function HostPortalLayout({ children }: LayoutProps<"/host">) {
  return <HostPortalFrame>{children}</HostPortalFrame>;
}

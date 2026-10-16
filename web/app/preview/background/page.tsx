import { BackgroundSample } from "@/components/room/background-sample";
import { isDevAuthBypass } from "@/lib/dev-bypass-flag";
import { redirect } from "next/navigation";

/* Local camera preview of the virtual background. Production builds never
 * enable the bypass, so this page redirects away. */

export default function PreviewBackgroundPage() {
  if (!isDevAuthBypass()) {
    redirect("/");
  }
  return <BackgroundSample />;
}

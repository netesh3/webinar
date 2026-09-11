import { PreviewEnableClient } from "@/components/preview-enable-client";
import { isDevAuthBypass } from "@/lib/dev-bypass-flag";
import { redirect } from "next/navigation";

/* Local preview entry: clear bypass opt-out and open Hosting.
 * Production builds never enable the env flag, so this redirects home. */

export default function PreviewIndexPage() {
  if (!isDevAuthBypass()) {
    redirect("/");
  }
  return <PreviewEnableClient />;
}

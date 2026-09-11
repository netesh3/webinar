import { PreviewRoom } from "@/components/room/preview-room";
import { isDevAuthBypass } from "@/lib/dev-bypass";
import { redirect } from "next/navigation";

/* Local UI review of room chrome + docked side panel. Production builds never
 * enable the bypass, so this page redirects away. */

export default function PreviewRoomPage() {
  if (!isDevAuthBypass()) {
    redirect("/");
  }
  return <PreviewRoom />;
}

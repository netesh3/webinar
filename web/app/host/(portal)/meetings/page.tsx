import { Suspense } from "react";
import { HostMeetingsScreen } from "@/components/host-meetings-screen";

// Client-rendered for the same reason as /host: the session is the browser's. Suspense
// because the list's tab row reads ?tab= with useSearchParams.
export default function HostMeetingsPage() {
  return (
    <Suspense fallback={null}>
      <HostMeetingsScreen />
    </Suspense>
  );
}

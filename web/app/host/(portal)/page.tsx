import { Suspense } from "react";
import { HostWebinarsScreen } from "@/components/host-webinars-screen";

// Client-rendered: the host session is an httpOnly cookie scoped to the API
// origin, and the browser is what holds it. The Suspense boundary is what ?tab=
// costs — the tab row reads it with useSearchParams, which cannot be resolved
// while the shell is prerendered.
export default function HostHomePage() {
  return (
    <Suspense fallback={null}>
      <HostWebinarsScreen />
    </Suspense>
  );
}

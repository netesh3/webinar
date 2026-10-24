import { Suspense } from "react";
import { StudioScreen } from "@/components/studio/studio-screen";

// The Studio: recordings, clips and their plan (the clips switch). Client-rendered like the
// rest of /host: the session is the browser's. Suspense because the view is ?view=, read with
// useSearchParams.
export default function HostStudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioScreen />
    </Suspense>
  );
}

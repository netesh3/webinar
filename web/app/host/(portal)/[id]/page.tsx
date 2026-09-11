import { Suspense } from "react";
import { HostWebinarScreen } from "@/components/host-webinar-screen";
import { Spinner } from "@/components/controls";

export default async function HostWebinarPage({
  params,
}: PageProps<"/host/[id]">) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-ink-3" />
        </div>
      }
    >
      <HostWebinarScreen slug={id} />
    </Suspense>
  );
}

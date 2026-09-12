import { notFound } from "next/navigation";
import { AttendeeRoomGate } from "@/components/attendee-room-gate";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";

export default async function AttendeeRoomPage({
  params,
}: PageProps<"/webinars/[id]/room">) {
  const { id } = await params;

  // Fetch inside try/catch, but construct the JSX outside it: React renders
  // lazily, so a render-time error would escape this catch anyway.
  let webinar: Webinar;
  try {
    webinar = await api.getWebinar(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <AttendeeRoomGate slug={id} topic={webinar.topic} imageUrl={webinar.imageUrl} />
  );
}

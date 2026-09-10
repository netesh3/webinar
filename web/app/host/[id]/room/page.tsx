import { HostRoomGate } from "@/components/host-room-gate";

export default async function HostRoomPage({
  params,
}: PageProps<"/host/[id]/room">) {
  const { id } = await params;
  // The topic is fetched client-side here: this route needs the host session
  // cookie, which a Server Component render on :3000 doesn't carry to :8080.
  return <HostRoomGate slug={id} />;
}

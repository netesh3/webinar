import { HostWebinarScreen } from "@/components/host-webinar-screen";

export default async function HostWebinarPage({
  params,
}: PageProps<"/host/[id]">) {
  const { id } = await params;
  return <HostWebinarScreen slug={id} />;
}

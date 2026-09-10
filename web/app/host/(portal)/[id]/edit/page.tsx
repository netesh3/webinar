import { EditWebinarScreen } from "@/components/edit-webinar-screen";

export default async function EditWebinarPage({
  params,
}: PageProps<"/host/[id]/edit">) {
  const { id } = await params;
  // Client-rendered: loading a webinar for editing needs the host session cookie,
  // which a Server Component render on :3000 does not carry to the API on :8080.
  return <EditWebinarScreen slug={id} />;
}

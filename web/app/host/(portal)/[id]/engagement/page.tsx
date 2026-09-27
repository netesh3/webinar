import { redirect } from "next/navigation";

/* The Engagement dashboard used to live here as its own page. It is now the host screen's
 * Engagement tab; old links and bookmarks land there. */
export default async function EngagementPage({ params }: PageProps<"/host/[id]/engagement">) {
  const { id } = await params;
  redirect(`/host/${encodeURIComponent(id)}?tab=engagement`);
}

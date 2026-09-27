import type { Metadata } from "next";
import { EngagementScreen } from "@/components/engagement/engagement-screen";

export const metadata: Metadata = {
  title: "Engagement",
  robots: { index: false, follow: false },
};

export default async function EngagementPage({ params }: PageProps<"/host/[id]/engagement">) {
  const { id } = await params;
  // Client-rendered, like the other host pages: the API needs the host's session cookie,
  // which a Server Component render does not carry across origins.
  return <EngagementScreen slug={id} />;
}

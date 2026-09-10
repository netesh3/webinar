import { redirect } from "next/navigation";

/** Kept as a redirect rather than deleted: /host/login was the host sign-in URL
 *  before accounts were unified, so it exists in bookmarks and in the E2E script. */
export default async function HostLoginPage({
  searchParams,
}: PageProps<"/host/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/host";
  redirect(`/login?next=${encodeURIComponent(next)}`);
}

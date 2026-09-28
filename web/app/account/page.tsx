import { redirect } from "next/navigation";

/** /account is the old address. Settings is the page; keep the query so a
 *  YouTube round trip that still says return=/account lands on the right card. */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") q.set(key, value);
    else if (value) for (const part of value) q.append(key, part);
  }
  const qs = q.toString();
  redirect(qs ? `/settings?${qs}` : "/settings");
}

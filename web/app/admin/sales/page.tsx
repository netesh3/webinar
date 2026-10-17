"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminScreen } from "@/components/admin-screen";
import { HostPortalFrame } from "@/components/host-portal-frame";

/* /admin/sales?c=<id> — where the "a visitor needs a person" email lands.
 *
 * The same admin screen as /admin, opened on Sales chats with that conversation
 * selected. Gated exactly like /admin: middleware matches /admin/:path*, and every
 * request behind it is requireAdmin on the API. */
function SalesAdmin() {
  const params = useSearchParams();
  return <AdminScreen initialTab="sales" salesConversation={params.get("c")} />;
}

export default function AdminSalesPage() {
  return (
    <HostPortalFrame>
      <h1 className="mb-1 text-[26px] font-semibold tracking-[-0.02em]">Administration</h1>
      <p className="mb-6 text-[14px] text-ink-2">Visitors the sales assistant handed to a person.</p>
      <Suspense>
        <SalesAdmin />
      </Suspense>
    </HostPortalFrame>
  );
}

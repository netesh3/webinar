"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "../providers";
import { IOS_APP_PLANS_NOTE, useIOSApp } from "../ios-app";
import { Badge, Button, Card } from "../ui";
import { api } from "@/lib/api";
import type { BillingStatus } from "@/lib/api-types";
import { ApiError } from "@/lib/http";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The plan the account is on: a free trial with its first-charge date, a renewing
 *  subscription, or a one-time payment's paid-until. A running subscription can be
 *  cancelled here, which stops it at once and ends the plan.
 *
 *  In the iOS app the plan is shown but not sold: no "See plans", and the neutral line
 *  where it would be (App Store guideline 3.1.1, components/ios-app.tsx). Cancelling
 *  stays, as it buys nothing. (29 Oct 2026) */
export function BillingCard() {
  const { refresh } = useSession();
  const iosApp = useIOSApp();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .myBilling()
      .then((b) => live && setBilling(b))
      .catch(() => live && setBilling({ active: false }));
    return () => {
      live = false;
    };
  }, []);

  if (!billing) return null;

  const cancel = async () => {
    const trial = billing.status === "trialing";
    const ok = window.confirm(
      trial
        ? "Cancel your free trial? You won't be charged, and the plan ends now."
        : "Cancel your subscription? It stops now and the plan ends.",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.cancelSubscription();
      setBilling(res.billing);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  let line = "No paid plan yet.";
  let badge: { tone?: "ok" | "warn"; text: string } = { text: "None" };
  if (billing.plan && billing.status === "trialing") {
    line = `Free trial · first charge on ${billing.trialEndsAt ? day(billing.trialEndsAt) : "the trial's last day"}. Cancel before then and you won't be charged.`;
    badge = { tone: "ok", text: "Trial" };
  } else if (billing.plan && billing.status === "past_due") {
    line = iosApp
      ? "Your last charge didn't go through."
      : "Your last charge didn't go through. Razorpay is retrying; update your payment method from the link in its email.";
    badge = { tone: "warn", text: "Payment due" };
  } else if (billing.plan && billing.renews) {
    line = billing.paidUntil ? `Renews monthly · next charge on ${day(billing.paidUntil)}.` : "Renews monthly.";
    badge = { tone: "ok", text: "Active" };
  } else if (billing.plan && billing.paidUntil) {
    line = billing.active ? `Paid until ${day(billing.paidUntil)}.` : `Ended on ${day(billing.paidUntil)}.`;
    badge = billing.active ? { tone: "ok", text: "Active" } : { text: "Ended" };
  }

  return (
    <Card className="mt-4 grid max-w-lg gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Plan &amp; billing</div>
          <div className="mt-0.5 text-[14px]">{billing.planName || "No plan"}</div>
        </div>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-2">{line}</p>
      {error && (
        <p className="text-[12px] text-live" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {billing.renews && (
          <Button variant="secondary" size="sm" onClick={cancel} disabled={busy}>
            {billing.status === "trialing" ? "Cancel trial" : "Cancel subscription"}
          </Button>
        )}
        {!billing.active && iosApp && <p className="text-[12.5px] text-ink-3">{IOS_APP_PLANS_NOTE}</p>}
        {!billing.active && !iosApp && (
          <Link href="/pricing#pricing" className="text-[12.5px] font-medium text-brand hover:underline">
            See plans
          </Link>
        )}
      </div>
    </Card>
  );
}

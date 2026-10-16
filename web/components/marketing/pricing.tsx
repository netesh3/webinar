"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingCatalogue, BillingCheckout, BillingPlan, BillingStatus } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import { CheckoutError, formatMoney, payWithRazorpay } from "@/lib/razorpay";
import { useSession } from "@/components/providers";

/* The pricing section, and buying from it.
 *
 * Prices come from GET /api/billing/plans — the same table the server charges
 * from — so this file has no numbers in it.
 *
 * Buying:
 *   signed out  → /signup, which comes back to /pricing?buy=… once signed in
 *   signed in   → order summary → Razorpay Checkout → the API verifies the
 *                 signature and turns hosting on → "You're a host now" → /host
 *
 * Used on the home page and on /pricing. /pricing is outside the middleware's
 * matcher, so a signed-in non-host can open it; the home page redirects them.
 */

type Period = "monthly" | "yearly";
type Currency = "INR" | "USD";
export type BuyIntent = { plan: string; period: Period; currency: Currency };

export function pricingHref(intent: BuyIntent): string {
  const q = new URLSearchParams({ buy: intent.plan, period: intent.period, currency: intent.currency });
  return `/pricing?${q.toString()}#pricing`;
}

/** Reads ?buy=…&period=…&currency=… as left by pricingHref, or null. */
export function buyIntentFromSearch(search: string): BuyIntent | null {
  const q = new URLSearchParams(search);
  const plan = q.get("buy");
  if (!plan) return null;
  const period = q.get("period") === "yearly" ? "yearly" : "monthly";
  const currency = q.get("currency") === "USD" ? "USD" : "INR";
  return { plan, period, currency };
}

function priceOf(plan: BillingPlan, currency: Currency, period: Period): number | undefined {
  return plan.prices.find((p) => p.currency === currency && p.period === period)?.amount;
}

export function Pricing({ autoBuy }: { autoBuy?: BuyIntent | null }) {
  const router = useRouter();
  const { status } = useSession();
  const [catalogue, setCatalogue] = useState<BillingCatalogue | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [period, setPeriod] = useState<Period>(autoBuy?.period ?? "monthly");
  const [currency, setCurrency] = useState<Currency>(autoBuy?.currency ?? "INR");
  const [buying, setBuying] = useState<BuyIntent | null>(null);
  // Closing the checkout that ?buy= opened must not reopen it.
  const [autoDone, setAutoDone] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .billingPlans()
      .then((c) => live && setCatalogue(c))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, []);

  // Back from sign-up with a plan in the URL: its checkout is open until closed.
  const autoOpen =
    !autoDone && autoBuy && status === "signed-in" && catalogue?.plans.some((p) => p.id === autoBuy.plan)
      ? autoBuy
      : null;
  const open = buying ?? autoOpen;

  const buy = (plan: string) => {
    const intent: BuyIntent = { plan, period, currency };
    if (status === "signed-in") {
      setAutoDone(true);
      setBuying(intent);
      return;
    }
    router.push(`/signup?next=${encodeURIComponent(pricingHref(intent))}`);
  };

  return (
    <section className="section pricing" id="pricing" aria-labelledby="pricing-title">
      <div className="wrap">
        <div className="section-head reveal">
          <p className="eyebrow">Pricing</p>
          <h2 id="pricing-title" className="h2">
            Pick a plan. <em>Go live today.</em>
          </h2>
          <p className="lede">
            Pay securely and your account is upgraded to host on the spot — no waiting for approval.
          </p>
          <div className="toggles">
            <div className="billing" role="radiogroup" aria-label="Billing period">
              <button type="button" role="radio" aria-checked={period === "monthly"} onClick={() => setPeriod("monthly")}>
                Monthly
              </button>
              <button type="button" role="radio" aria-checked={period === "yearly"} onClick={() => setPeriod("yearly")}>
                Yearly <span className="save">2 months free</span>
              </button>
            </div>
            <div className="billing" role="radiogroup" aria-label="Currency">
              <button type="button" role="radio" aria-checked={currency === "INR"} onClick={() => setCurrency("INR")}>
                ₹ INR
              </button>
              <button type="button" role="radio" aria-checked={currency === "USD"} onClick={() => setCurrency("USD")}>
                $ USD
              </button>
            </div>
          </div>
        </div>

        {loadError && (
          <p className="pricing-foot" role="alert">
            Prices didn&apos;t load. Refresh the page to try again.
          </p>
        )}

        <div className="plans" aria-busy={!catalogue}>
          {(catalogue?.plans ?? PLACEHOLDER_PLANS).map((plan) => {
            const amount = catalogue ? priceOf(plan, currency, period) : undefined;
            const perMonth = amount !== undefined ? (period === "yearly" ? Math.round(amount / 12) : amount) : undefined;
            return (
              <article key={plan.id} className={plan.popular ? "plan plan-pop reveal" : "plan reveal"}>
                {plan.popular && <span className="plan-badge">Most popular</span>}
                <header>
                  <h3>{plan.name}</h3>
                  <p>{plan.who}</p>
                </header>
                <p className="price">
                  {perMonth !== undefined ? (
                    <>
                      <b>{formatMoney(perMonth, currency)}</b>
                      <span className="per">/month</span>
                    </>
                  ) : (
                    <span className="price-skel" aria-label="Loading price" />
                  )}
                </p>
                <p className="billed">
                  {amount === undefined
                    ? " "
                    : period === "yearly"
                      ? `${formatMoney(amount, currency)} billed yearly`
                      : "Billed monthly"}
                  {currency === "INR" && catalogue && catalogue.gstPercent > 0 ? ` · + ${catalogue.gstPercent}% GST` : ""}
                </p>
                <button
                  type="button"
                  className={plan.popular ? "btn btn-primary btn-block" : "btn btn-ghost btn-block"}
                  disabled={!catalogue}
                  onClick={() => buy(plan.id)}
                >
                  Buy {plan.name}
                </button>
                <ul className="ticks">
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>

        <ol className="buy-steps reveal" aria-label="How buying works">
          <li>
            <span className="bs-n">1</span>
            <div>
              <b>Choose a plan</b>
              <span>Sign in, or create your account in one step.</span>
            </div>
          </li>
          <li>
            <span className="bs-n">2</span>
            <div>
              <b>Pay securely</b>
              <span>UPI, cards, netbanking or wallets, through Razorpay.</span>
            </div>
          </li>
          <li>
            <span className="bs-n">3</span>
            <div>
              <b>Host access, instantly</b>
              <span>Your account is upgraded the moment payment clears.</span>
            </div>
          </li>
        </ol>
        <p className="pricing-foot">
          Payments secured by Razorpay. WhatsApp message fees are billed by Meta to your own WhatsApp Business account.
        </p>
      </div>

      {open && catalogue && (
        <CheckoutDialog
          intent={open}
          catalogue={catalogue}
          onClose={() => {
            setBuying(null);
            setAutoDone(true);
          }}
        />
      )}
    </section>
  );
}

/* Rendered before the catalogue loads so the section has its shape. Names only —
 * the prices stay blank until the server's arrive. */
const PLACEHOLDER_PLANS: BillingPlan[] = [
  { id: "professional", name: "Professional", who: "For coaches and consultants", attendees: 0, features: [], prices: [] },
  { id: "business", name: "Business", who: "For coaches selling programs", attendees: 0, features: [], prices: [], popular: true },
  { id: "enterprise", name: "Enterprise", who: "For academies and teams", attendees: 0, features: [], prices: [] },
];

// ------------------------------------------------------------------ checkout

type Step =
  | { kind: "summary"; error?: string; gstinError?: string }
  | { kind: "paying"; order?: BillingCheckout }
  | { kind: "verifying" }
  | { kind: "done"; billing: BillingStatus; paymentId: string };

function CheckoutDialog({
  intent,
  catalogue,
  onClose,
}: {
  intent: BuyIntent;
  catalogue: BillingCatalogue;
  onClose: () => void;
}) {
  const router = useRouter();
  const { account, refresh } = useSession();
  const [step, setStep] = useState<Step>({ kind: "summary" });
  const [gstin, setGstin] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  const plan = catalogue.plans.find((p) => p.id === intent.plan);
  const subtotal = plan ? priceOf(plan, intent.currency, intent.period) : undefined;
  const tax =
    subtotal !== undefined && intent.currency === "INR"
      ? Math.round((subtotal * catalogue.gstPercent) / 100)
      : 0;
  const busy = step.kind === "paying" || step.kind === "verifying";

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!plan || subtotal === undefined) return null;

  const pay = async (e: FormEvent) => {
    e.preventDefault();
    if (!catalogue.enabled) {
      setStep({ kind: "summary", error: "Online payment isn't switched on yet. Write to us and we'll enable your plan." });
      return;
    }
    setStep({ kind: "paying" });
    let order: BillingCheckout;
    try {
      order = await api.createBillingOrder({
        plan: intent.plan,
        period: intent.period,
        currency: intent.currency,
        gstin: gstin.trim() || undefined,
      });
    } catch (err) {
      if (err instanceof ApiError && err.fields?.gstin) {
        setStep({ kind: "summary", gstinError: err.fields.gstin });
      } else {
        setStep({ kind: "summary", error: err instanceof ApiError ? err.message : "Couldn't start the payment. Try again." });
      }
      return;
    }
    setStep({ kind: "paying", order });

    let signed;
    try {
      const cfg = await api.config().catch(() => null);
      signed = await payWithRazorpay(order, cfg?.appName || "Webinar Liv");
    } catch (err) {
      const msg =
        err instanceof CheckoutError && err.reason === "dismissed"
          ? "Payment cancelled — nothing was charged. You can try again whenever you're ready."
          : err instanceof Error
            ? err.message
            : "The payment didn't go through.";
      setStep({ kind: "summary", error: msg });
      return;
    }

    setStep({ kind: "verifying" });
    try {
      const res = await api.verifyBillingPayment(signed);
      await refresh();
      setStep({ kind: "done", billing: res.billing, paymentId: res.paymentId });
    } catch (err) {
      setStep({
        kind: "summary",
        error:
          (err instanceof ApiError ? err.message : "We couldn't confirm the payment yet.") +
          ` If you were charged, your plan turns on automatically within a few minutes (ref ${signed.razorpay_payment_id}).`,
      });
    }
  };

  const total = subtotal + tax;
  const periodLabel = intent.period === "yearly" ? "Yearly" : "Monthly";

  return (
    <div className="co-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialog}
        className="co-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="co-title"
        tabIndex={-1}
        data-step={step.kind}
      >
        {step.kind === "done" ? (
          <div className="co-done">
            <div className="co-ok" aria-hidden>
              <svg viewBox="0 0 24 24">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <h2 id="co-title">You&apos;re a host now</h2>
            <p>
              Payment received. Your {step.billing.planName || plan.name} plan is active and host access is turned on.
            </p>
            <ul className="co-perms">
              <li>
                <span>Host webinars</span>
                <b>Enabled</b>
              </li>
              {step.billing.attendees ? (
                <li>
                  <span>Up to {step.billing.attendees} attendees</span>
                  <b>Enabled</b>
                </li>
              ) : null}
              <li>
                <span>Plan</span>
                <b className="plain">
                  {plan.name} · {periodLabel}
                </b>
              </li>
            </ul>
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => router.push("/host")}>
              Schedule your first webinar
            </button>
            <p className="co-fine">
              Payment {step.paymentId}
              {step.billing.paidUntil ? ` · Paid until ${new Date(step.billing.paidUntil).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}
            </p>
          </div>
        ) : (
          <form onSubmit={pay}>
            <header className="co-head">
              <div>
                <h2 id="co-title">Complete your purchase</h2>
                {account && <small>Signed in as {account.email}</small>}
              </div>
              <button type="button" className="co-x" aria-label="Close" onClick={close} disabled={busy}>
                ✕
              </button>
            </header>
            <div className="co-body">
              <div className="co-plan">
                <b>
                  {plan.name} plan · {periodLabel}
                </b>
                <span>
                  Up to {plan.attendees} attendees · host access included
                </span>
              </div>
              <dl className="co-sum">
                <div>
                  <dt>
                    {plan.name} ({intent.period === "yearly" ? "1 year" : "1 month"})
                  </dt>
                  <dd>{formatMoney(subtotal, intent.currency, { exact: true })}</dd>
                </div>
                {tax > 0 && (
                  <div>
                    <dt>GST ({catalogue.gstPercent}%)</dt>
                    <dd>{formatMoney(tax, intent.currency, { exact: true })}</dd>
                  </div>
                )}
                <div className="co-total">
                  <dt>Total due today</dt>
                  <dd>{formatMoney(total, intent.currency, { exact: true })}</dd>
                </div>
              </dl>
              {intent.currency === "INR" && (
                <label className="co-field">
                  <span>GSTIN (optional)</span>
                  <input
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    placeholder="22AAAAA0000A1Z5"
                    maxLength={15}
                    autoComplete="off"
                    aria-invalid={step.kind === "summary" && !!step.gstinError}
                    disabled={busy}
                  />
                  {step.kind === "summary" && step.gstinError && <em role="alert">{step.gstinError}</em>}
                </label>
              )}
              {step.kind === "summary" && step.error && (
                <p className="co-error" role="alert">
                  {step.error}
                </p>
              )}
            </div>
            <footer className="co-foot">
              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
                {step.kind === "verifying"
                  ? "Confirming payment…"
                  : step.kind === "paying"
                    ? "Waiting for payment…"
                    : `Pay ${formatMoney(total, intent.currency, { exact: true })}`}
              </button>
              <p className="co-fine">Opens secure Razorpay checkout · UPI, cards, netbanking</p>
              <p className="co-fine">
                By paying you agree to the <Link href="/terms">Terms</Link>.
              </p>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

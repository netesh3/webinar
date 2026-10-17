"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { BillingCatalogue, BillingCheckout, BillingPlan, BillingStatus, TrialCheckout } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import { planCta } from "@/lib/pricing-cta";
import { CheckoutError, authoriseTrial, formatMoney, payWithRazorpay } from "@/lib/razorpay";
import { useSession } from "@/components/providers";
import { SUPPORT_EMAIL } from "@/components/marketing/legal-page";

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
/** trial: the 7-day free trial (monthly) rather than paying now. */
export type BuyIntent = { plan: string; period: Period; currency: Currency; trial?: boolean };

export function pricingHref(intent: BuyIntent): string {
  const q = new URLSearchParams({ buy: intent.plan, period: intent.period, currency: intent.currency });
  if (intent.trial) q.set("trial", "1");
  return `/pricing?${q.toString()}#pricing`;
}

/** Reads ?buy=…&period=…&currency=…&trial=1 as left by pricingHref, or null. */
export function buyIntentFromSearch(search: string): BuyIntent | null {
  const q = new URLSearchParams(search);
  const plan = q.get("buy");
  if (!plan) return null;
  const period = q.get("period") === "yearly" ? "yearly" : "monthly";
  const currency = q.get("currency") === "USD" ? "USD" : "INR";
  return { plan, period, currency, trial: q.get("trial") === "1" };
}

function priceOf(plan: BillingPlan, currency: Currency, period: Period): number | undefined {
  return plan.prices.find((p) => p.currency === currency && p.period === period)?.amount;
}

/* The regular price the early-bird one is shown against, struck through, and how
 * far below it the real price is — both from the server. Display only. */
function listOf(
  plan: BillingPlan,
  currency: Currency,
  period: Period,
): { list: number; pct: number; promo: string } | undefined {
  const p = plan.prices.find((x) => x.currency === currency && x.period === period);
  return p?.list && p.discountPercent ? { list: p.list, pct: p.discountPercent, promo: p.promo ?? "" } : undefined;
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
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

  const buy = (plan: BillingPlan) => {
    const trial = planCta(plan, period, currency, catalogue) === "trial";
    const intent: BuyIntent = { plan: plan.id, period, currency, trial };
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
            {catalogue && catalogue.trialDays > 0
              ? `${catalogue.trialDays}-day free trial on monthly plans · card or UPI · ₹5 refundable check · cancel anytime before day ${catalogue.trialDays + 1}.`
              : "Pay securely and your account is upgraded to host on the spot — no waiting for approval."}
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
            const cta = planCta(plan, period, currency, catalogue);
            const amount = catalogue ? priceOf(plan, currency, period) : undefined;
            const perMonth = amount !== undefined ? (period === "yearly" ? Math.round(amount / 12) : amount) : undefined;
            const regular = catalogue ? listOf(plan, currency, period) : undefined;
            const listPerMonth =
              regular !== undefined ? (period === "yearly" ? Math.round(regular.list / 12) : regular.list) : undefined;
            const btnClass = plan.popular ? "btn btn-primary btn-block" : "btn btn-ghost btn-block";
            return (
              <article key={plan.id} className={plan.popular ? "plan plan-pop reveal" : "plan reveal"}>
                {plan.popular && <span className="plan-badge">Most popular</span>}
                <header>
                  <h3>{plan.name}</h3>
                  <p>{plan.who}</p>
                </header>
                {cta === "contact" ? (
                  <>
                    <p className="price">
                      <b className="price-contact">Contact us</b>
                    </p>
                    <p className="billed">Custom pricing, set up with our team</p>
                  </>
                ) : (
                  <>
                    {listPerMonth !== undefined && regular ? (
                      <p className="price-was">
                        <s aria-label={`Regular price ${formatMoney(listPerMonth, currency)} a month`}>
                          {formatMoney(listPerMonth, currency)}
                        </s>
                        <span className="promo">
                          {regular.promo ? `${regular.promo} · ` : ""}Save {regular.pct}%
                        </span>
                      </p>
                    ) : null}
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
                          : cta === "trial"
                            ? `Free for ${catalogue?.trialDays} days, then billed monthly`
                            : "Billed monthly"}
                    </p>
                  </>
                )}
                {cta === "contact" ? (
                  <a className={btnClass} href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${plan.name} plan`)}`}>
                    Contact us
                  </a>
                ) : (
                  <button type="button" className={btnClass} disabled={!catalogue} onClick={() => buy(plan)}>
                    {cta === "trial" ? `Start ${catalogue?.trialDays}-day free trial` : `Buy ${plan.name}`}
                  </button>
                )}
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
        {catalogue && catalogue.gstPercent > 0 && (
          <p className="pricing-foot">
            All prices exclude GST. {catalogue.gstPercent}% GST is added at checkout for payments in INR.
          </p>
        )}
        <p className="pricing-foot">
          Payments secured by Razorpay. WhatsApp message fees are billed by Meta to your own WhatsApp Business account.
        </p>
      </div>

      {open && catalogue && open.trial && (
        <TrialDialog
          intent={open}
          catalogue={catalogue}
          onPayNow={() => setBuying({ ...open, trial: false })}
          onClose={() => {
            setBuying(null);
            setAutoDone(true);
          }}
        />
      )}
      {open && catalogue && !open.trial && (
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

// ------------------------------------------------------------------ free trial

type TrialStep =
  | { kind: "summary"; error?: string; needsPhone?: boolean }
  | { kind: "used" }
  | { kind: "starting" }
  | { kind: "authorising"; trial: TrialCheckout }
  | { kind: "verifying"; trial: TrialCheckout }
  | { kind: "done"; billing: BillingStatus };

/* The 7-day free trial: a Razorpay subscription whose first charge is a week out.
 * Checkout authorises a mandate today (a small refundable check); nothing is paid
 * until the trial ends. A phone or email that already had a trial gets a plain
 * "you've used it" with the two ways forward, not the raw refusal. */
function TrialDialog({
  intent,
  catalogue,
  onPayNow,
  onClose,
}: {
  intent: BuyIntent;
  catalogue: BillingCatalogue;
  onPayNow: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { account, refresh } = useSession();
  const [step, setStep] = useState<TrialStep>({ kind: "summary" });
  const dialog = useRef<HTMLDivElement>(null);

  const plan = catalogue.plans.find((p) => p.id === intent.plan);
  const subtotal = plan ? priceOf(plan, intent.currency, "monthly") : undefined;
  const tax =
    subtotal !== undefined && intent.currency === "INR" ? Math.round((subtotal * catalogue.gstPercent) / 100) : 0;
  const busy = step.kind === "starting" || step.kind === "authorising" || step.kind === "verifying";
  // When the dialog opened, so the date shown does not move while it is open.
  const [firstCharge] = useState(() => new Date(Date.now() + catalogue.trialDays * 86_400_000).toISOString());

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
  const monthly = subtotal + tax;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setStep({ kind: "starting" });
    let trial: TrialCheckout;
    try {
      trial = await api.startTrial(intent.plan);
    } catch (err) {
      if (err instanceof ApiError && err.code === "trial_used") {
        setStep({ kind: "used" });
      } else if (err instanceof ApiError && err.code === "phone_required") {
        setStep({ kind: "summary", needsPhone: true, error: err.message });
      } else {
        setStep({ kind: "summary", error: err instanceof ApiError ? err.message : "Couldn't start the trial. Try again." });
      }
      return;
    }
    setStep({ kind: "authorising", trial });

    let signed;
    try {
      const cfg = await api.config().catch(() => null);
      signed = await authoriseTrial(trial, cfg?.appName || "Webinar Liv");
    } catch (err) {
      const msg =
        err instanceof CheckoutError && err.reason === "dismissed"
          ? "Trial not started — nothing was charged. You can try again whenever you're ready."
          : err instanceof Error
            ? err.message
            : "The authorisation didn't go through.";
      setStep({ kind: "summary", error: msg });
      return;
    }

    setStep({ kind: "verifying", trial });
    try {
      const res = await api.verifyTrial(signed);
      await refresh();
      setStep({ kind: "done", billing: res.billing });
    } catch (err) {
      if (err instanceof ApiError && err.code === "trial_used") {
        setStep({ kind: "used" });
        return;
      }
      setStep({
        kind: "summary",
        error:
          (err instanceof ApiError ? err.message : "We couldn't confirm the trial yet.") +
          " If Checkout said it worked, your trial starts automatically within a few minutes.",
      });
    }
  };

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
            <h2 id="co-title">Your free trial has started</h2>
            <p>
              {plan.name} is on for {catalogue.trialDays} days and host access is turned on. Cancel any time before{" "}
              {step.billing.trialEndsAt ? longDate(step.billing.trialEndsAt) : longDate(firstCharge)} in Settings and
              you won&apos;t be charged.
            </p>
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => router.push("/host")}>
              Schedule your first webinar
            </button>
            <p className="co-fine">
              Then {formatMoney(monthly, intent.currency, { exact: true })} a month from{" "}
              {step.billing.trialEndsAt ? longDate(step.billing.trialEndsAt) : longDate(firstCharge)}
            </p>
          </div>
        ) : step.kind === "used" ? (
          <div className="co-done">
            <h2 id="co-title">You&apos;ve already used a free trial</h2>
            <p>
              Each person gets one free trial. You can start the {plan.name} plan now, or write to us if something
              went wrong with your trial.
            </p>
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={onPayNow}>
              Start paid plan
            </button>
            <a
              className="btn btn-ghost btn-block"
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Free trial")}`}
            >
              Contact support
            </a>
          </div>
        ) : (
          <form onSubmit={start}>
            <header className="co-head">
              <div>
                <h2 id="co-title">Start your free trial</h2>
                {account && <small>Signed in as {account.email}</small>}
              </div>
              <button type="button" className="co-x" aria-label="Close" onClick={close} disabled={busy}>
                ✕
              </button>
            </header>
            <div className="co-body">
              <div className="co-plan">
                <b>
                  {plan.name} plan · {catalogue.trialDays}-day free trial
                </b>
                <span>Up to {plan.attendees} attendees · host access included</span>
              </div>
              <dl className="co-sum">
                <div>
                  <dt>Today</dt>
                  <dd>₹5 refundable check</dd>
                </div>
                <div className="co-total">
                  <dt>From {longDate(firstCharge)}</dt>
                  <dd>{formatMoney(monthly, intent.currency, { exact: true })} / month</dd>
                </div>
              </dl>
              <p className="co-fine">
                Card or UPI AutoPay. Cancel any time before {longDate(firstCharge)} in Settings and you won&apos;t be
                charged{tax > 0 ? ` · includes ${catalogue.gstPercent}% GST` : ""}.
              </p>
              {step.kind === "summary" && step.error && (
                <p className="co-error" role="alert">
                  {step.error}
                  {step.needsPhone && (
                    <>
                      {" "}
                      <Link href="/settings#profile">Add it in Settings</Link>
                    </>
                  )}
                </p>
              )}
            </div>
            <footer className="co-foot">
              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
                {step.kind === "verifying"
                  ? "Confirming…"
                  : step.kind === "authorising"
                    ? "Waiting for authorisation…"
                    : step.kind === "starting"
                      ? "Starting…"
                      : `Start ${catalogue.trialDays}-day free trial`}
              </button>
              <p className="co-fine">
                By starting the trial you agree to the <Link href="/terms">Terms</Link>.
              </p>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

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

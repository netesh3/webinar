"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { SUPPORT_EMAIL } from "@/components/marketing/legal-page";
import {
  ADD_ONS,
  AI_CREDIT_COSTS,
  COMPARISON,
  FREE_MONTHS_YEARLY,
  GST_PERCENT,
  PLANS,
  PLANS_STATUS,
  PLAN_IDS,
  TRIAL,
  findPlan,
  formatPrice,
  perMonth,
  priceFor,
  yearlySavingPercent,
  type Cell,
  type Currency,
  type Period,
  type Plan,
} from "@/lib/plans";
import "@/app/landing.css";
import "@/app/plans.css";

/* The proposed plans, drawn from lib/plans.ts: the cards, the add-ons, the comparison
 * table, the AI credits list and the FAQ. Shared by /features and /pricing/proposed. No
 * checkout here: while PLANS_STATUS is "proposal", buying stays on /pricing, which charges
 * the server's live price list. */

const LIVE = PLANS_STATUS === "live";

export function Check({ label }: { label?: string }) {
  return (
    <svg className="ic pl-yes" viewBox="0 0 24 24" role={label ? "img" : undefined} aria-label={label} aria-hidden={!label}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/** The note that these are proposed prices, not what checkout charges today. */
export function ProposalNote() {
  if (LIVE) return null;
  return (
    <div className="pl-note" role="note">
      <div className="wrap">
        <p>
          <b>Proposed pricing.</b> These plans are a proposal and are not on sale yet. Checkout still uses the{" "}
          <Link href="/pricing">current price list</Link>.
        </p>
      </div>
    </div>
  );
}

/** Where a plan's button goes: the live checkout once these are the real plans. */
function planHref(plan: Plan): string {
  if (!plan.monthly) return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${plan.name} plan`)}`;
  return LIVE ? `/signup?next=${encodeURIComponent("/pricing")}` : "/pricing#pricing";
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="billing" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The plan cards with the period and currency toggles. */
export function PlanCards({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const [period, setPeriod] = useState<Period>("monthly");
  const [currency, setCurrency] = useState<Currency>("INR");
  const Title = headingLevel === 2 ? "h2" : "h3";
  const saving = yearlySavingPercent(findPlan("starter"), currency);

  return (
    <section className="section pricing" id="plans" aria-labelledby="plans-title">
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">Pricing</p>
          <Title id="plans-title" className="h2">
            Simple plans. <em>Room to grow.</em>
          </Title>
          <p className="lede">
            {TRIAL.days}-day free trial with {findPlan(TRIAL.plan).name} limits. Prices exclude GST. Cancel any time.
          </p>
          <div className="toggles">
            <Toggle
              label="Billing period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "monthly", label: "Monthly" },
                {
                  value: "yearly",
                  label: (
                    <>
                      Yearly <span className="save">{FREE_MONTHS_YEARLY} months free</span>
                    </>
                  ),
                },
              ]}
            />
            <Toggle
              label="Currency"
              value={currency}
              onChange={setCurrency}
              options={[
                { value: "INR", label: "₹ INR" },
                { value: "USD", label: "$ USD" },
              ]}
            />
          </div>
        </div>

        <div className="plans plans-4">
          {PLANS.map((plan) => {
            const pm = perMonth(plan, currency, period);
            const total = priceFor(plan, currency, period);
            const l = plan.limits;
            return (
              <article key={plan.id} className={plan.popular ? "plan plan-pop" : "plan"} aria-labelledby={`plan-${plan.id}`}>
                {plan.popular && <span className="plan-badge">Most popular</span>}
                <header>
                  <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
                  <p>{plan.who}</p>
                </header>
                {pm === null ? (
                  <>
                    <p className="price">
                      <b className="price-contact">Let&apos;s talk</b>
                    </p>
                    <p className="billed">Custom pricing and limits</p>
                  </>
                ) : (
                  <>
                    <p className="price">
                      <b>{formatPrice(pm, currency)}</b>
                      <span className="per">/month</span>
                    </p>
                    <p className="billed">
                      {period === "yearly"
                        ? `${formatPrice(total!, currency)} billed yearly · save ${saving}%`
                        : "Billed monthly"}
                    </p>
                  </>
                )}
                <a className={plan.popular ? "btn btn-primary btn-block" : "btn btn-ghost btn-block"} href={planHref(plan)}>
                  {plan.monthly ? (plan.id === TRIAL.plan ? `Start ${TRIAL.days}-day free trial` : `Choose ${plan.name}`) : "Contact us"}
                </a>
                {l && (
                  <dl className="pl-limits">
                    <div>
                      <dt>Attendees</dt>
                      <dd>{l.attendees.toLocaleString("en-IN")}</dd>
                    </div>
                    <div>
                      <dt>Attendee-hours</dt>
                      <dd>{l.attendeeHours.toLocaleString("en-IN")}/mo</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>{l.recordingGb} GB</dd>
                    </div>
                    <div>
                      <dt>AI credits</dt>
                      <dd>{l.aiCredits ? `${l.aiCredits.toLocaleString("en-IN")}/mo` : "Add-on"}</dd>
                    </div>
                  </dl>
                )}
                <ul className="ticks">
                  {plan.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        <p className="pricing-foot">
          {GST_PERCENT}% GST is added to INR payments, with a GST invoice. USD payments are charged without GST. Pay
          with UPI, cards, netbanking or wallets through Razorpay.
        </p>
      </div>
    </section>
  );
}

export function AddOns() {
  const [currency, setCurrency] = useState<Currency>("INR");
  return (
    <section className="section pl-addons" aria-labelledby="addons-title">
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">Add-ons</p>
          <h2 id="addons-title" className="h2">
            Need more? <em>Top up.</em>
          </h2>
          <p className="lede">Add only what you use. Packs apply to the billing month they are bought in.</p>
          <Toggle
            label="Add-on currency"
            value={currency}
            onChange={setCurrency}
            options={[
              { value: "INR", label: "₹ INR" },
              { value: "USD", label: "$ USD" },
            ]}
          />
        </div>
        <ul className="pl-addon-grid">
          {ADD_ONS.map((a) => (
            <li key={a.id} className="pl-card">
              <h3>{a.name}</h3>
              <p>{a.detail}</p>
              <p className="pl-addon-price">
                <b>{formatPrice(a.price[currency], currency)}</b> / {a.per}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CellView({ cell, plan }: { cell: Cell; plan: string }) {
  if (cell === true) return <Check label={`Included in ${plan}`} />;
  if (cell === false)
    return (
      <span className="pl-no" aria-label={`Not in ${plan}`}>
        –
      </span>
    );
  return <span className="pl-val">{cell}</span>;
}

/** Every plan side by side. Scrolls sideways on a phone, with the feature column pinned. */
export function CompareTable() {
  const plans = PLAN_IDS.map(findPlan);
  return (
    <section className="section pl-compare" id="compare" aria-labelledby="compare-title">
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">Compare plans</p>
          <h2 id="compare-title" className="h2">
            Everything, <em>side by side</em>
          </h2>
        </div>
        <div className="pl-table-wrap" tabIndex={0} role="region" aria-label="Plan comparison, scrolls sideways">
          <table className="pl-table">
            <caption className="sr-only">Features and limits of each plan</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Feature</span>
                </th>
                {plans.map((p) => (
                  <th key={p.id} scope="col" className={p.popular ? "pl-pop" : undefined}>
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            {COMPARISON.map((g) => (
              <tbody key={g.id}>
                <tr className="pl-group">
                  <th scope="colgroup" colSpan={plans.length + 1}>
                    {g.title}
                  </th>
                </tr>
                {g.rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">
                      {r.label}
                      {r.hint && <small>{r.hint}</small>}
                    </th>
                    {plans.map((p) => (
                      <td key={p.id} className={p.popular ? "pl-pop" : undefined}>
                        <CellView cell={r.cells[p.id]} plan={p.name} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </section>
  );
}

/** What each AI action costs in credits. */
export function AiCredits() {
  return (
    <section className="section pl-credits" id="ai-credits" aria-labelledby="credits-title">
      <div className="wrap pl-credits-grid">
        <div className="pl-credits-head">
          <p className="eyebrow">AI credits</p>
          <h2 id="credits-title" className="h2">
            One allowance <em>for every AI feature</em>
          </h2>
          <p className="lede">
            AI is off until you turn it on. Pro includes {findPlan("pro").limits!.aiCredits.toLocaleString("en-IN")}{" "}
            credits a month and Business {findPlan("business").limits!.aiCredits.toLocaleString("en-IN")}; Starter can
            add AI. Unused credits do not roll over, and AI stops at zero rather than charging you more.
          </p>
        </div>
        <table className="pl-credit-table">
          <caption className="sr-only">AI credits per action</caption>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Credits</th>
            </tr>
          </thead>
          <tbody>
            {AI_CREDIT_COSTS.map((c) => (
              <tr key={c.action}>
                <th scope="row">{c.action}</th>
                <td>
                  {c.credits} <span>per {c.per}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FaqItem({ question, open, children }: { question: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open}>
      <summary>
        {question}
        <svg className="ic" viewBox="0 0 24 24" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <p>{children}</p>
    </details>
  );
}

export function PlansFaq() {
  const pro = findPlan("pro");
  return (
    <section className="section faq" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div className="faq-head">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title" className="h2">
            Pricing <em>questions</em>
          </h2>
          <p className="lede">
            Something else? Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </p>
        </div>
        <div className="faq-list">
          <FaqItem open question="How does the free trial work?">
            You get {TRIAL.days} days with {pro.name} limits and {TRIAL.aiCredits} AI credits. Razorpay sets up a mandate
            with a small refundable check; nothing is charged until day {TRIAL.days + 1}, and you can cancel before then.
            One trial per person. The trial is in rupees; buyers paying in dollars start on a paid month.
          </FaqItem>
          <FaqItem question="Can I pay in INR or USD?">
            Both. Indian cards, UPI, netbanking and wallets pay in rupees; international cards can pay in US dollars.
            Prices differ by currency because they are set for each market, not converted.
          </FaqItem>
          <FaqItem question="Do I get a GST invoice?">
            Yes. {GST_PERCENT}% GST is added to rupee payments and shown on the invoice; add your GSTIN at checkout to
            claim input credit. Dollar payments from outside India are charged without GST.
          </FaqItem>
          <FaqItem question="Can I cancel any time?">
            Yes, from Settings. Cancel a trial before it ends and you are never charged. Yearly plans cost{" "}
            {FREE_MONTHS_YEARLY} months less than paying monthly.
          </FaqItem>
          <FaqItem question="What is an attendee-hour?">
            One person watching for one hour. 200 people at a 90-minute webinar use 300. When a month&apos;s hours run out
            your sessions keep running, and we ask you to add a pack or move up a plan.
          </FaqItem>
          <FaqItem question="How long are recordings kept?">
            For your plan&apos;s retention period from the end of the session. We email you a week and a day before a
            recording expires; one click keeps it for 3 more months, as long as you are within your storage. You can
            download a recording at any time.
          </FaqItem>
          <FaqItem question="How do AI credits work?">
            Every AI action uses a few credits from your monthly allowance: a one-hour recap is 10, an answer draft is
            1. AI is off until you turn it on, it only drafts (you decide what is sent), and it stops when the credits
            run out instead of billing you more.
          </FaqItem>
          <FaqItem question="Who pays for WhatsApp messages?">
            Meta bills WhatsApp message fees to your own WhatsApp Business account. We do not mark them up.
          </FaqItem>
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="final-glow" aria-hidden />
      <div className="wrap final-inner">
        <h2 id="final-title" className="h2">
          {title}
        </h2>
        {children}
        <div className="cta-row">
          <Link className="btn btn-white btn-lg" href="/signup">
            Start your free trial <ArrowRight />
          </Link>
          <a className="btn btn-outline-light btn-lg" href={`mailto:${SUPPORT_EMAIL}`}>
            Talk to us
          </a>
        </div>
        <ul className="checks on-dark">
          <li>
            <Check /> {TRIAL.days} days free
          </li>
          <li>
            <Check /> No download for attendees
          </li>
          <li>
            <Check /> Your contacts, exportable any time
          </li>
        </ul>
      </div>
    </section>
  );
}

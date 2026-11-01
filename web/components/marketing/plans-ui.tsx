"use client";

import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { CONTACT, mailto } from "@/lib/contact";
import {
  COMPARISON,
  GST_PERCENT,
  PLANS,
  PLANS_STATUS,
  PLAN_IDS,
  TRIAL,
  YEARLY_OFF_PERCENT,
  cardLines,
  discountPercent,
  findPlan,
  formatPrice,
  listFor,
  monthlyShare,
  offLabel,
  perMonth,
  priceFor,
  type Cell,
  type Currency,
  type Period,
  type Plan,
} from "@/lib/plans";
import { allOpen, rowCountLabel, sectionAnchor, sectionFromHash, setAll, toggleSection } from "@/lib/compare-accordion";
import "@/app/landing.css";
import "@/app/plans.css";

/* The plans, drawn from lib/plans.ts: the cards, the "Compare all features" table and the FAQ.
 * Shared by /features and, for the table, /pricing (components/marketing/pricing.tsx, which
 * gives it the live prices and buy buttons). No checkout here: buying is on /pricing, which
 * charges the server's price list, and a Go test holds lib/plans.ts to that list. */

const LIVE = PLANS_STATUS === "live";

export function Check({ label }: { label?: string }) {
  return (
    <svg
      className="ic pl-yes"
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={!label}
    >
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

/** Where a plan's button goes: Enterprise is an email, the rest buy on /pricing. */
function planHref(plan: Plan): string {
  if (plan.contactOnly) return mailto(CONTACT.hello, `${plan.name} plan`);
  return "/pricing#pricing";
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
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The yearly toggle's label: the saving, never "months free" (31 Oct 2026). */
export function YearlyLabel() {
  return (
    <>
      Yearly <span className="save">{YEARLY_OFF_PERCENT}% OFF</span>
    </>
  );
}

/** The struck-out list price and its badge above a price, both per month. */
export function PriceWas({
  list,
  amount,
  currency,
  period,
}: {
  list: number | null;
  amount: number;
  currency: Currency;
  period: Period;
}) {
  const pct = discountPercent(amount, list);
  if (!list || !pct) return null;
  const was = formatPrice(monthlyShare(list, period), currency);
  return (
    <p className="price-was">
      <s aria-label={`List price ${was} a month`}>{was}</s>
      <span className="promo">{offLabel(pct)}</span>
    </p>
  );
}

/** The plan cards with the period and currency toggles. */
export function PlanCards({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const [period, setPeriod] = useState<Period>("monthly");
  const [currency, setCurrency] = useState<Currency>("INR");
  const Title = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className="section pricing" id="plans" aria-labelledby="plans-title">
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">Pricing</p>
          <Title id="plans-title" className="h2">
            Simple plans. <em>Room to grow.</em>
          </Title>
          <p className="lede">{TRIAL.days}-day free trial on monthly plans. Prices exclude GST. Cancel any time.</p>
          <div className="toggles">
            <Toggle
              label="Billing period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: <YearlyLabel /> },
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
            return (
              <article
                key={plan.id}
                className={plan.popular ? "plan plan-pop" : "plan"}
                aria-labelledby={`plan-${plan.id}`}
              >
                {plan.popular && <span className="plan-badge">Most popular</span>}
                <header>
                  <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
                  <p>{plan.who}</p>
                </header>
                {pm === null || total === null ? (
                  <>
                    <p className="price">
                      <b className="price-contact">Let&apos;s talk</b>
                    </p>
                    <p className="billed">Custom pricing and limits</p>
                  </>
                ) : (
                  <>
                    <PriceWas
                      list={listFor(plan, currency, period)}
                      amount={total}
                      currency={currency}
                      period={period}
                    />
                    <p className="price">
                      <b>{formatPrice(pm, currency)}</b>
                      <span className="per">/month</span>
                    </p>
                    <p className="billed">
                      {period === "yearly" ? `${formatPrice(total, currency)} billed yearly` : "Billed monthly"}
                    </p>
                  </>
                )}
                <a
                  className={plan.popular ? "btn btn-primary btn-block" : "btn btn-ghost btn-block"}
                  href={planHref(plan)}
                >
                  {plan.contactOnly ? "Contact us" : `Choose ${plan.name}`}
                </a>
                <p className="plan-lead">{plan.lead}</p>
                <ul className="ticks">
                  {cardLines(plan).map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        <p className="pl-compare-cta">
          {/* As prominent as the trial button (1 Nov 2026): the full table is the next question. */}
          <a className="btn btn-primary btn-lg" href="#compare">
            Compare all features ↓
          </a>
        </p>
        <p className="pricing-foot">
          {GST_PERCENT}% GST is added to INR payments, with a GST invoice. USD payments are charged without GST. Pay
          with UPI, cards, netbanking or wallets through Razorpay.
        </p>
      </div>
    </section>
  );
}

function CellView({ cell, plan, label }: { cell: Cell; plan: string; label: string }) {
  if (cell === true) return <Check label={`${label}: included in ${plan}`} />;
  if (cell === false)
    return (
      <span className="pl-no" role="img" aria-label={`${label}: not in ${plan}`}>
        —
      </span>
    );
  return <span className="pl-val">{cell}</span>;
}

// The comparison's sections, in order: the accordion's ids.
const SECTION_IDS = COMPARISON.map((g) => g.id);

/** The sticky header's price and button for one plan. */
export type CompareHead = { price: ReactNode; cta: ReactNode };

/** The header /features shows: the monthly INR price, and a link to buy on /pricing. */
function staticHead(plan: Plan): CompareHead {
  const m = priceFor(plan, "INR", "monthly");
  return {
    price: m === null ? "Contact us" : `${formatPrice(m, "INR")}/mo`,
    cta: (
      <a className={plan.popular ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"} href={planHref(plan)}>
        {plan.contactOnly ? "Contact us" : "Choose"}
      </a>
    ),
  };
}

/* "Compare all features": every plan side by side, grouped, with a sticky header of plan names,
 * prices and buttons (modelled on zoom.us/pricing/events). On a phone it scrolls sideways
 * with the feature column pinned. `head` gives /pricing's live prices and buy buttons. */
export function CompareTable({ head = staticHead }: { head?: (plan: Plan) => CompareHead }) {
  const plans = PLAN_IDS.map(findPlan);
  /* Every section starts collapsed (2 Nov 2026), on the server too, so nothing renders open and
   * then closes. A section's header opens or closes it; #compare-<section> opens that one. */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const everyOpen = allOpen(open, SECTION_IDS);
  useEffect(() => {
    const fromHash = () => {
      const id = sectionFromHash(window.location.hash, SECTION_IDS);
      if (!id) return;
      setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      // After the rows are in, so the section lands where the browser would have put it.
      requestAnimationFrame(() => document.getElementById(sectionAnchor(id))?.scrollIntoView({ block: "start" }));
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  return (
    <section className="section pl-compare" id="compare" aria-labelledby="compare-title">
      <div className="wrap">
        <div className="section-head">
          <p className="eyebrow">Compare plans</p>
          <h2 id="compare-title" className="h2">
            Compare <em>all features</em>
          </h2>
        </div>
        <div className="pl-accordion-bar">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-controls={SECTION_IDS.map((id) => `${sectionAnchor(id)}-rows`).join(" ")}
            onClick={() => setOpen(setAll(SECTION_IDS, !everyOpen))}
          >
            {everyOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
        <div
          className="pl-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Plan comparison, scrolls sideways on a phone"
        >
          <table className="pl-table">
            <caption className="sr-only">Features and limits of each plan</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Feature</span>
                </th>
                {plans.map((p) => {
                  const h = head(p);
                  return (
                    <th key={p.id} scope="col" className={p.popular ? "pl-pop" : undefined}>
                      <span className="pl-head-name">{p.name}</span>
                      <span className="pl-head-price">{h.price}</span>
                      <span className="pl-head-cta">{h.cta}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {COMPARISON.map((g) => {
              const isOpen = open.has(g.id);
              const anchor = sectionAnchor(g.id);
              return (
                <Fragment key={g.id}>
                  <tbody id={anchor} className="pl-section">
                    <tr className="pl-group">
                      <th scope="colgroup" colSpan={plans.length + 1}>
                        <button
                          type="button"
                          className="pl-group-toggle"
                          aria-expanded={isOpen}
                          aria-controls={`${anchor}-rows`}
                          onClick={() => setOpen((prev) => toggleSection(prev, g.id))}
                        >
                          <svg className="ic pl-chevron" viewBox="0 0 24 24" aria-hidden>
                            <path d="m9 6 6 6-6 6" />
                          </svg>
                          <span className="pl-group-title">{g.title}</span>
                          <span className="pl-group-count">{rowCountLabel(g.rows.length)}</span>
                        </button>
                      </th>
                    </tr>
                  </tbody>
                  <tbody id={`${anchor}-rows`} hidden={!isOpen}>
                    {g.rows.map((r) => (
                      <tr key={r.label}>
                        <th scope="row" title={r.hint}>
                          {r.label}
                          {r.hint && <small>{r.hint}</small>}
                        </th>
                        {plans.map((p) => (
                          <td key={p.id} className={p.popular ? "pl-pop" : undefined}>
                            <CellView cell={r.cells[p.id]} plan={p.name} label={r.label} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Fragment>
              );
            })}
          </table>
        </div>
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
  return (
    <section className="section faq" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div className="faq-head">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title" className="h2">
            Pricing <em>questions</em>
          </h2>
          <p className="lede">
            Something else? Write to <a href={`mailto:${CONTACT.support}`}>{CONTACT.support}</a>.
          </p>
        </div>
        <div className="faq-list">
          <FaqItem open question="How does the free trial work?">
            You get {TRIAL.days} days on the monthly plan you pick. Razorpay sets up a mandate with a small refundable
            check; nothing is charged until day {TRIAL.days + 1}, and you can cancel before then. One trial per person.
            The trial is in rupees; buyers paying in dollars start on a paid month.
          </FaqItem>
          <FaqItem question="Can I pay in INR or USD?">
            Both. Indian cards, UPI, netbanking and wallets pay in rupees; international cards can pay in US dollars.
            Prices differ by currency because they are set for each market, not converted.
          </FaqItem>
          <FaqItem question="Do I get a GST invoice?">
            Yes. {GST_PERCENT}% GST is added to rupee payments and shown on the invoice; add your GSTIN at checkout to
            claim input credit. Dollar payments from outside India are charged without GST. For a copy of an invoice, a
            refund or any payment question, write to <a href={`mailto:${CONTACT.billing}`}>{CONTACT.billing}</a>.
          </FaqItem>
          <FaqItem question="Can I cancel any time?">
            Yes, from Settings. Cancel a trial before it ends and you are never charged. A yearly plan is paid once for
            the year, at {YEARLY_OFF_PERCENT}% off its list price.
          </FaqItem>
          <FaqItem question="Where are my recordings kept?">
            On every plan you can record in the browser and keep the file on your computer. Cloud recording is on
            Professional and up: a cloud recording is kept 30 days from the end of the session, we email you a week
            and a day before it expires, and one click keeps it for 3 more months while you are within your
            plan&apos;s storage. Your storage holds the videos you upload and your cloud recordings together.
          </FaqItem>
          <FaqItem question="Which plans have captions?">
            Every plan has live captions made on each speaker&apos;s device. Business and Enterprise add server live
            captions, in English and eight Indian languages.
          </FaqItem>
          <FaqItem question="Which plans have AI?">
            Business and Enterprise: recaps, Q&amp;A answer drafts, the knowledge base, follow-up drafts and
            repurposing. AI only drafts (you decide what is sent), and it works within a monthly AI limit.
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
          <a className="btn btn-outline-light btn-lg" href={`mailto:${CONTACT.hello}`}>
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

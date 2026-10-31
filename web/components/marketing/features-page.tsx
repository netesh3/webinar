import Link from "next/link";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { ArrowRight, Check, CompareTable, FinalCta, PlanCards, PlansFaq, ProposalNote } from "@/components/marketing/plans-ui";
import { TRIAL, availability, featureGroups, pricingHref } from "@/lib/plans";

/* /features: every shipped feature, grouped, with the plan each is on. The sections and
 * the plan badges come from lib/plans.ts (COMPARISON), the same rows as the pricing
 * table, so the two pages cannot disagree. (31 Oct 2026: no clips or instant sessions, which
 * no plan sells.) */

export function FeaturesPage() {
  const groups = featureGroups();
  return (
    <div className="home">
      <div className="lp lp-features">
        <ProposalNote />
        <section className="hero hero-dark pl-hero" aria-labelledby="features-title">
          <div className="hero-bg" aria-hidden />
          <div className="wrap">
            <div className="hero-copy">
              <p className="eyebrow pl-hero-eyebrow">Features</p>
              <h1 id="features-title" className="h1">
                Everything to run, fill and <em className="grad-text">sell from</em> your webinars.
              </h1>
              <p className="hero-lede">
                Live webinars, meetings and simulive in the browser. Registration, reminders and engagement scoring
                built in. On Business and up, AI that drafts your recaps, answers and follow-ups, and turns sessions
                into content.
              </p>
              <div className="cta-row">
                <Link className="btn btn-primary btn-lg" href="/signup">
                  Start {TRIAL.days}-day free trial <ArrowRight />
                </Link>
                <Link className="btn btn-outline-light btn-lg" href={pricingHref()}>
                  See pricing
                </Link>
              </div>
              <ul className="checks on-dark">
                <li>
                  <Check /> No download for attendees
                </li>
                <li>
                  <Check /> Pay in ₹ or $
                </li>
                <li>
                  <Check /> GST invoice
                </li>
              </ul>
            </div>
          </div>
        </section>

        <nav className="pl-jump" aria-label="Feature sections">
          <div className="wrap">
            <ul>
              {groups.map((g) => (
                <li key={g.id}>
                  <a href={`#${g.id}`}>{g.title}</a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {groups.map((g, i) => (
          <section
            key={g.id}
            id={g.id}
            className={i % 2 ? "section pl-feature-section pl-alt" : "section pl-feature-section"}
            aria-labelledby={`${g.id}-title`}
          >
            <div className="wrap">
              <div className="pl-section-head">
                <h2 id={`${g.id}-title`} className="h2">
                  {g.title}
                </h2>
                <p className="lede">{g.intro}</p>
              </div>
              <ul className="pl-feature-grid">
                {g.rows
                  .filter((r) => r.detail)
                  .map((r) => {
                    const on = availability(r);
                    return (
                      <li key={r.label} className="pl-card">
                        <h3>{r.label}</h3>
                        <p>{r.detail}</p>
                        <span className={on === "Every plan" ? "pl-badge" : "pl-badge pl-badge-up"}>{on}</span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          </section>
        ))}

        <PlanCards />
        <CompareTable />
        <PlansFaq />
        <FinalCta
          title={
            <>
              Run your next webinar <em>on Webinar Liv</em>
            </>
          }
        />
      </div>
      <HomeLegalFooter />
    </div>
  );
}

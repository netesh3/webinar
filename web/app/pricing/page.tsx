"use client";

import Link from "next/link";
import { useState } from "react";
import { TopNav } from "@/components/top-nav";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { useSession } from "@/components/providers";

export default function PricingPage() {
  const { account } = useSession();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">(
    "monthly"
  );

  const tiers = [
    {
      name: "Professional",
      monthlyPrice: 49,
      annualPrice: 490,
      annualSavings: 98,
      description: "Perfect for coaches and consultants",
      capacity: "200 attendees",
      features: [
        "200 concurrent attendees",
        "Unlimited webinars",
        "3-hour duration limit",
        "HD video & screen sharing",
        "Chat & Q&A with upvoting",
        "Polls & reactions",
        "Engagement analytics (0-100 scoring)",
        "Host controls (mute, hide, lock)",
        "Recording downloads (MP4)",
        "Virtual backgrounds",
        "Email confirmations & reminders",
        "Priority email support",
      ],
      cta: "Start Free Trial",
      highlighted: false,
    },
    {
      name: "Business",
      monthlyPrice: 199,
      annualPrice: 1890,
      annualSavings: 298,
      description: "For training companies and agencies",
      capacity: "300 attendees",
      features: [
        "300 concurrent attendees",
        "Everything in Professional, plus:",
        "Multi-streaming (YouTube, LinkedIn)",
        "WhatsApp CRM Lite (500 contacts)",
        "Server-side recording",
        "50GB recording storage",
        "Custom domain white-label",
        "Co-host accounts (up to 3)",
        "Dedicated onboarding call",
        "4-hour support SLA",
        "Advanced host controls",
        "Analytics CSV export",
      ],
      cta: "Start Free Trial",
      highlighted: true,
    },
    {
      name: "Enterprise",
      monthlyPrice: 499,
      annualPrice: 4990,
      annualSavings: 998,
      description: "For large organizations",
      capacity: "500 attendees",
      features: [
        "500 concurrent attendees",
        "Everything in Business, plus:",
        "Dedicated infrastructure",
        "WhatsApp CRM Full (unlimited)",
        "Simulive capability",
        "200GB recording storage",
        "API access",
        "Multiple brands/white-label",
        "Multiple host accounts (up to 10)",
        "Breakout rooms",
        "Dedicated account manager",
        "1-hour support SLA",
      ],
      cta: "Contact Sales",
      highlighted: false,
    },
  ];

  return (
    <>
      <TopNav />
      <main className="flex-1">
        <div className="pricing-page">
          {/* Hero Section */}
          <section className="pricing-hero">
            <div className="pricing-hero-inner">
              <h1 className="pricing-headline">
                Simple, Transparent Pricing
              </h1>
              <p className="pricing-lede">
                Start free. Scale as you grow. No hidden fees.
              </p>

              {/* Billing Toggle */}
              <div className="pricing-toggle-container">
                <div className="pricing-toggle">
                  <button
                    onClick={() => setBillingCycle("monthly")}
                    className={`pricing-toggle-btn ${
                      billingCycle === "monthly" ? "active" : ""
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    onClick={() => setBillingCycle("annual")}
                    className={`pricing-toggle-btn ${
                      billingCycle === "annual" ? "active" : ""
                    }`}
                  >
                    Annual
                    <span className="pricing-badge">Save 2 months</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Pricing Tiers */}
          <section className="pricing-tiers">
            <div className="pricing-grid">
              {tiers.map((tier) => {
                const price =
                  billingCycle === "monthly" ? tier.monthlyPrice : tier.annualPrice;
                const billingText =
                  billingCycle === "monthly" ? "/month" : "/year";
                const savings =
                  billingCycle === "monthly" ? null : tier.annualSavings;

                return (
                  <div
                    key={tier.name}
                    className={`pricing-card ${tier.highlighted ? "highlighted" : ""}`}
                  >
                    {tier.highlighted && (
                      <div className="pricing-card-badge">Most Popular</div>
                    )}

                    <div className="pricing-card-header">
                      <h3 className="pricing-tier-name">{tier.name}</h3>
                      <p className="pricing-tier-desc">{tier.description}</p>
                      <p className="pricing-capacity">{tier.capacity}</p>
                    </div>

                    <div className="pricing-card-price">
                      <span className="pricing-currency">€</span>
                      <span className="pricing-amount">{price}</span>
                      <span className="pricing-billing">{billingText}</span>
                      {savings && (
                        <div className="pricing-savings">
                          <span>Save €{savings}</span>
                          <span className="pricing-save-pct">
                            {Math.round((savings / (billingCycle === "monthly" ? price * 12 : price)) * 100)}% off
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="pricing-card-cta">
                      <Link
                        href={
                          account
                            ? `/pricing/checkout?tier=${tier.name.toLowerCase()}&billing=${billingCycle}`
                            : `/signup?tier=${tier.name.toLowerCase()}&billing=${billingCycle}`
                        }
                        className={`pricing-btn ${
                          tier.highlighted ? "primary" : "secondary"
                        }`}
                      >
                        {tier.cta}
                      </Link>
                      {tier.cta === "Start Free Trial" && (
                        <p className="pricing-trial-info">
                          7 days free, then €{price} {billingText}
                        </p>
                      )}
                    </div>

                    <div className="pricing-card-features">
                      <p className="pricing-features-label">Includes:</p>
                      <ul className="pricing-features-list">
                        {tier.features.map((feature, idx) => (
                          <li key={idx} className="pricing-feature">
                            <svg
                              className="pricing-feature-icon"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* FAQ Section */}
          <section className="pricing-faq">
            <div className="pricing-faq-inner">
              <h2 className="pricing-faq-title">Frequently Asked Questions</h2>

              <div className="pricing-faq-grid">
                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">How does the 7-day trial work?</h3>
                  <p className="pricing-faq-a">
                    Sign up with your credit card and get full access to Professional
                    features for 7 days. We'll automatically charge your card on day 8
                    unless you cancel. No commitment required.
                  </p>
                </div>

                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">Can I upgrade or downgrade anytime?</h3>
                  <p className="pricing-faq-a">
                    Yes! Upgrade or downgrade your plan anytime from your account
                    settings. Changes take effect immediately.
                  </p>
                </div>

                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">Do you offer invoices?</h3>
                  <p className="pricing-faq-a">
                    Yes. Invoices are automatically generated and sent to your email
                    after each payment. You can download them anytime from your
                    account.
                  </p>
                </div>

                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">What if I need custom features?</h3>
                  <p className="pricing-faq-a">
                    Contact our sales team at pricing@webinarliv.com for custom
                    solutions, white-label options, or multi-year agreements.
                  </p>
                </div>

                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">Is there a setup fee?</h3>
                  <p className="pricing-faq-a">
                    No setup fees, no hidden charges. You only pay the monthly
                    subscription. That's it.
                  </p>
                </div>

                <div className="pricing-faq-item">
                  <h3 className="pricing-faq-q">What's your refund policy?</h3>
                  <p className="pricing-faq-a">
                    30-day money-back guarantee. If you're not satisfied within 30
                    days of your first charge, we'll refund you completely.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* CTA Band */}
          <section className="pricing-cta-band">
            <div className="pricing-cta-inner">
              <h2>Ready to get started?</h2>
              <p>
                Join hundreds of webinar hosts running professional sessions on
                Webinar Liv.
              </p>
              <Link href={account ? "/app/pricing/checkout" : "/signup"} className="pricing-cta-btn">
                Start Your 7-Day Free Trial
              </Link>
            </div>
          </section>
        </div>
      </main>
      <HomeLegalFooter />
    </>
  );
}

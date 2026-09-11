import Link from "next/link";
import type { ReactNode } from "react";
import { TopNav } from "@/components/top-nav";

const SUPPORT_EMAIL = "support@webinarliv.com";

export { SUPPORT_EMAIL };

type LegalPageProps = {
  title: string;
  updated: string;
  children: ReactNode;
};

/** Shared shell for Privacy / Terms — marketing tokens, readable prose, no hero. */
export function LegalPage({ title, updated, children }: LegalPageProps) {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        <article className="home legal">
          <div className="legal-inner">
            <p className="legal-kicker">
              <Link href="/">Webinar Liv</Link>
            </p>
            <h1 className="legal-title">{title}</h1>
            <p className="legal-meta">Last updated: {updated}</p>
            <div className="legal-body">{children}</div>
            <LegalFooterNav />
          </div>
        </article>
      </main>
    </>
  );
}

export function LegalFooterNav() {
  return (
    <nav className="legal-footer-nav" aria-label="Legal">
      <Link href="/privacy">Privacy Policy</Link>
      <span aria-hidden>·</span>
      <Link href="/terms">Terms of Service</Link>
      <span aria-hidden>·</span>
      <Link href="/">Home</Link>
      <span aria-hidden>·</span>
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
    </nav>
  );
}

export function HomeLegalFooter() {
  return (
    <footer className="home-legal-footer">
      <div className="home-section-inner home-legal-footer-inner">
        <p className="home-legal-footer-brand">Webinar Liv</p>
        <nav className="home-legal-footer-links" aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <a href={`mailto:${SUPPORT_EMAIL}`}>Contact</a>
        </nav>
      </div>
    </footer>
  );
}

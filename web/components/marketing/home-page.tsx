"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { useAppConfig, useSession } from "@/components/providers";

/* Public marketing home for Webinar Liv.
 *
 * Only features that ship today. Signed-in visitors are redirected away (see
 * middleware + SignedInHomeRedirect); this page is for logged-out guests.
 */

/** Client fallback when middleware did not see a session cookie yet.
 *  Skips redirect when `?marketing=1` so local preview can force the homepage. */
export function SignedInHomeRedirect() {
  const router = useRouter();
  const { account, status } = useSession();

  useEffect(() => {
    if (status !== "signed-in" || !account) return;
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("marketing") === "1") return;
    }
    router.replace(account.canHost ? "/host" : "/browse");
  }, [account, status, router]);

  return null;
}

export function HomePage() {
  const { appName } = useAppConfig();

  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="home-brand">
        <div className="home-hero-atmosphere" aria-hidden />
        <div className="home-hero-grid">
          <div className="home-hero-copy">
            <p id="home-brand" className="home-brand home-reveal">
              {appName}
            </p>
            <h1 className="home-headline home-reveal home-reveal-delay-1">
              Host webinars your audience can actually join
            </h1>
            <p className="home-lede home-reveal home-reveal-delay-2">
              Schedule, register, and go live with video, chat, Q&amp;A, and
              polls — self-hosted on open infrastructure.
            </p>
            <div className="home-cta home-reveal home-reveal-delay-3">
              <Link href="/signup" className="home-btn home-btn-primary">
                Get started
              </Link>
              <Link
                href="/login?next=/host"
                className="home-btn home-btn-ghost"
              >
                Host a webinar
              </Link>
              <Link href="/browse" className="home-btn home-btn-text">
                Browse
              </Link>
            </div>
          </div>
          <div className="home-hero-visual home-reveal home-reveal-delay-2">
            <HeroStage />
          </div>
        </div>
      </section>

      <section className="home-section" aria-labelledby="home-what">
        <div className="home-section-inner home-split">
          <div>
            <h2 id="home-what" className="home-h2">
              Built for webinars, not meetings
            </h2>
            <p className="home-body">
              One clear stage for hosts and panelists, a quiet audience by
              default, and a registration path that works with or without an
              account.
            </p>
          </div>
          <ul className="home-bullets">
            <li>Schedule sessions and invite panelists by email</li>
            <li>Public register pages with join keys and optional guest join</li>
            <li>Admit queue when you want control over who enters</li>
            <li>Attendance lists you can export as CSV</li>
          </ul>
        </div>
      </section>

      <section
        className="home-section home-section-alt"
        aria-labelledby="home-engage"
      >
        <div className="home-section-inner">
          <h2 id="home-engage" className="home-h2">
            Keep the room interactive
          </h2>
          <p className="home-body home-body-narrow">
            Engagement tools sit beside the stage so you can answer questions and
            read the room without leaving the session.
          </p>
          <div className="home-feature-grid">
            <Feature
              title="Chat"
              body="Public or panelists-only chat with history that survives reconnects."
            />
            <Feature
              title="Q&A"
              body="Collect questions, let attendees upvote, and answer live."
            />
            <Feature
              title="Polls & quizzes"
              body="Draft, open, and close polls while the session is running."
            />
            <Feature
              title="Raise hand & reactions"
              body="Attendees can signal, and the room can react in the moment."
            />
          </div>
        </div>
      </section>

      <section className="home-section" aria-labelledby="home-control">
        <div className="home-section-inner home-split home-split-reverse">
          <div className="home-anchor" aria-hidden>
            <ControlVisual />
          </div>
          <div>
            <h2 id="home-control" className="home-h2">
              Host controls that stay out of the way
            </h2>
            <p className="home-body">
              Decide what the audience sees, who speaks, and how the stage is
              laid out — without wrestling the tool.
            </p>
            <ul className="home-bullets">
              <li>Speaker, grid, and spotlight layouts with pin</li>
              <li>Screen share, window share, and file or video share</li>
              <li>Mute, bring on stage, lock, and end for all</li>
              <li>Record the session from the room when you need a copy</li>
              <li>Optional background blur for presenters</li>
            </ul>
          </div>
        </div>
      </section>

      <section
        className="home-section home-section-alt"
        aria-labelledby="home-access"
      >
        <div className="home-section-inner">
          <h2 id="home-access" className="home-h2">
            Sign in simply — or skip it to attend
          </h2>
          <p className="home-body home-body-narrow">
            Hosts and panelists use an account. Attendees can register with a
            join key, continue with Google when configured, or join as a guest
            when you allow it.
          </p>
          <ul className="home-inline-list">
            <li>Email and password</li>
            <li>Google sign-in</li>
            <li>Passcode-gated sessions</li>
            <li>Manual admit</li>
          </ul>
        </div>
      </section>

      <section className="home-section home-cta-band" aria-labelledby="home-end">
        <div className="home-section-inner home-cta-band-inner">
          <h2 id="home-end" className="home-h2">
            Ready when you are
          </h2>
          <p className="home-body">
            Browse what&apos;s on, create an account, or open Hosting if you
            already run sessions here.
          </p>
          <div className="home-cta">
            <Link href="/signup" className="home-btn home-btn-primary">
              Get started
            </Link>
            <Link href="/browse" className="home-btn home-btn-ghost">
              Browse webinars
            </Link>
          </div>
        </div>
      </section>

      <HomeLegalFooter />
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="home-feature">
      <h3 className="home-feature-title">{title}</h3>
      <p className="home-feature-body">{body}</p>
    </div>
  );
}

/** Full-bleed stage mock — visual anchor for the hero, not a marketing card. */
function HeroStage() {
  return (
    <div
      className="home-stage"
      role="img"
      aria-label="Illustration of a live webinar stage"
    >
      <div className="home-stage-bar">
        <span className="home-stage-live">
          <span className="home-stage-live-dot" />
          Live
        </span>
        <span className="home-stage-bar-label">Stage</span>
      </div>
      <div className="home-stage-main">
        <div className="home-stage-speaker">
          <div className="home-stage-avatar" />
          <span>Host</span>
        </div>
        <div className="home-stage-rail">
          <div className="home-stage-tile" />
          <div className="home-stage-tile" />
          <div className="home-stage-tile home-stage-tile-share" />
        </div>
      </div>
      <div className="home-stage-tools">
        <span>Chat</span>
        <span>Q&amp;A</span>
        <span>Polls</span>
      </div>
    </div>
  );
}

function ControlVisual() {
  return (
    <div className="home-control-visual">
      <div className="home-control-row">
        <span>Layout</span>
        <strong>Speaker</strong>
      </div>
      <div className="home-control-row">
        <span>Share</span>
        <strong>Screen</strong>
      </div>
      <div className="home-control-row">
        <span>Audience</span>
        <strong>Admit</strong>
      </div>
    </div>
  );
}

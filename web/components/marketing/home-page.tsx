"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { LaunchDemoButton } from "@/components/marketing/launch-demo";
import { useSession } from "@/components/providers";

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
  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="home-headline">
        <div className="home-hero-atmosphere" aria-hidden />
        <div className="home-hero-inner">
          <div className="home-stage-wrap">
            <FeatureChip
              className="home-chip-1"
              tone="blue"
              label="Screen sharing"
              caption="Share a window or file"
              icon={
                <>
                  <rect x="2" y="4" width="20" height="13" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                  <path d="m9 11 3-3 3 3" />
                </>
              }
            />
            <FeatureChip
              className="home-chip-2"
              tone="indigo"
              label="Interactive Q&A"
              caption="Upvote and answer live"
              icon={
                <>
                  <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  <path d="M9.6 9a2.5 2.5 0 1 1 3.1 2.4c-.5.2-.7.6-.7 1.1v.3" />
                  <path d="M12 15.6h.01" />
                </>
              }
            />
            <FeatureChip
              className="home-chip-3"
              tone="rose"
              label="Recording"
              caption="Save every session"
              icon={
                <>
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
                </>
              }
            />
            <FeatureChip
              className="home-chip-4"
              tone="amber"
              label="Live polls"
              caption="Read the room instantly"
              icon={<path d="M4 19V9M10 19V5M16 19v-6M22 19H2" />}
            />

            <div className="home-player home-reveal">
              <div className="home-screen">
                <CallGrid />

                <span className="home-live-badge">
                  <i aria-hidden />
                  LIVE
                </span>

                <span className="home-viewers">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  1,284 watching
                </span>

                <div className="home-player-bar" aria-hidden>
                  <span className="home-room-tag">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <span className="home-room-tag-text">
                      <b>1 host</b> · 3 panelists · 1,278 attending
                    </span>
                  </span>
                  <div className="home-player-ctrls">
                    <span className="home-player-ctrl">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z" />
                        <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
                      </svg>
                    </span>
                    <span className="home-player-ctrl">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="6" width="14" height="12" rx="2.5" />
                        <path d="m16 11 6-3.5v9L16 13z" />
                      </svg>
                    </span>
                    <span className="home-player-ctrl">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="4" width="20" height="13" rx="2" />
                        <path d="M8 21h8M12 17v4" />
                      </svg>
                    </span>
                    <span className="home-player-ctrl home-player-ctrl-leave">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 5h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6" />
                        <path d="m6 15-3-3 3-3M3 12h9" />
                      </svg>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="home-hero-copy">
            <h1 id="home-headline" className="home-headline home-reveal home-reveal-delay-1">
              The Ultimate Live Webinar Platform.{" "}
              <span className="home-headline-accent">
                Connect, Engage, and Grow.
              </span>
            </h1>
            <p className="home-lede home-reveal home-reveal-delay-2">
              Run polished webinars with HD video, screen sharing, live Q&amp;A,
              polls and recording — no downloads for your audience, just a
              link.
            </p>
            <div className="home-cta home-reveal home-reveal-delay-3">
              <Link href="/signup" className="home-btn home-btn-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="2" y="6" width="14" height="12" rx="2.5" />
                  <path d="m16 11 6-3.5v9L16 13z" />
                </svg>
                Start a webinar
              </Link>
              <Link href="/browse" className="home-btn home-btn-ghost">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <path d="m10 17 5-5-5-5M15 12H3" />
                </svg>
                Join a webinar
              </Link>
              <LaunchDemoButton className="home-btn home-btn-ghost" />
            </div>
            <ul className="home-trust home-reveal home-reveal-delay-3">
              <li>
                <CheckMark />
                No download required
              </li>
              <li>
                <CheckMark />
                Up to 1,000 attendees
              </li>
              <li>
                <CheckMark />
                Self-hosted and private
              </li>
            </ul>
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

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

/** One of the soft cards floating around the player. Decorative: every feature
 *  named here is spelled out properly in the sections below, so a screen reader
 *  hearing the page in order is not made to sit through it twice. */
function FeatureChip({
  className,
  tone,
  label,
  caption,
  icon,
}: {
  className: string;
  tone: "blue" | "indigo" | "rose" | "amber";
  label: string;
  caption: string;
  icon: ReactNode;
}) {
  return (
    <div className={`home-chip ${className}`} aria-hidden>
      <span className={`home-chip-ic home-chip-${tone}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </span>
      <div>
        {label}
        <small>{caption}</small>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the call
 *
 * Real people, not an illustration — office and home-office settings,
 * sourced from Pexels (free-to-use license, no attribution required) and
 * served from this app rather than hotlinked, so the hero does not depend on
 * a third party's uptime or slow down waiting on it. Photos are pre-sized and
 * compressed at the source (Pexels' own resize params) specifically for this
 * layout, which is why five portraits add under 140KB total — well within
 * budget for a mobile hero.
 *
 * The grid itself is the point as much as the faces in it: host large on the
 * left, panelists stacked smaller on the right, audience smaller again along
 * the bottom. That is not decoration, it is the product — a webinar is not a
 * meeting of equals — and the layout says so before the copy explains it.
 */

type CallPerson = {
  photo?: string;
  initials?: string;
  name: string;
  role?: string;
  speaking?: boolean;
  muted?: boolean;
};

function CallTile({ person, panelist }: { person: CallPerson; panelist?: boolean }) {
  const label = person.role ? `${person.name} · ${person.role}` : person.name;
  return (
    <div className={`home-call-tile ${person.speaking ? "home-call-tile-speaking" : ""}`}>
      {person.photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- pre-sized and
        // pre-compressed at the source (see the comment above CallGrid); the
        // optimizer next/image would run has already been done once, by hand.
        <img src={person.photo} alt="" loading="eager" />
      ) : (
        <div className="home-call-avatar">{person.initials}</div>
      )}
      <span className="home-call-name">
        {panelist && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
            <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z" />
            <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
          </svg>
        )}
        {label}
      </span>
      {person.speaking && (
        <span className="home-call-level" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
      {person.muted && (
        <span className="home-call-muted" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
            <path d="M4 4l16 16M12 4a3 3 0 0 1 3 3v3M9 10v2a3 3 0 0 0 4.5 2.6" />
          </svg>
        </span>
      )}
    </div>
  );
}

function CallGrid() {
  return (
    <div
      className="home-call-grid"
      role="img"
      aria-label="A webinar in progress: the host on a large tile, with panelists and audience on smaller tiles around it"
    >
      <div className="home-call-tile home-call-host home-call-tile-speaking">
        {/* eslint-disable-next-line @next/next/no-img-element -- see CallTile */}
        <img src="/images/hero/host.jpg" alt="" loading="eager" />
        <span className="home-call-name">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
            <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z" />
            <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
          </svg>
          Amlesh Kumar · Host
        </span>
        <span className="home-call-level" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>

      <div className="home-call-panelists">
        <CallTile person={{ photo: "/images/hero/panelist-1.jpg", name: "Shweta Gupta", role: "Panelist", speaking: true }} panelist />
        <CallTile person={{ photo: "/images/hero/panelist-2.jpg", name: "Anil Meru", role: "Panelist", muted: true }} panelist />
        <CallTile person={{ initials: "SS", name: "Sunil SP", role: "Panelist" }} panelist />
      </div>

      <div className="home-call-audience" aria-hidden>
        <CallTile person={{ photo: "/images/hero/audience-1.jpg", name: "Zoya" }} />
        <CallTile person={{ photo: "/images/hero/audience-2.jpg", name: "Dev" }} />
        <CallTile person={{ initials: "V", name: "Vishal" }} />
        <div className="home-call-tile">
          <div className="home-call-more">
            <b>+1,272</b>
            <span>in the audience</span>
          </div>
        </div>
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

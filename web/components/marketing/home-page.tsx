"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
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
                    <b>1 host</b> · 3 panelists · 1,278 attending
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
 * A drawn webinar rather than a photograph or a stock video, for three
 * reasons that all point the same way: nobody has to be asked for their
 * likeness, it weighs a few kilobytes instead of a few megabytes on a
 * connection that has not loaded the app yet, and it can say something a
 * photograph cannot — that the host gets the big tile and everyone else does
 * not. That layout IS the product: a webinar is not a meeting of equals, and
 * the hero should show the difference before the copy explains it.
 *
 * The mouths, eyes and level meter animate; nothing here plays audio, and
 * `prefers-reduced-motion` stops all of it (see globals.css).
 */

/* Hair shapes, over a head drawn at cx 80 / cy 32 / r 19.
 *
 * Each is an arc across the top of the skull and a fringe curve back under it,
 * so the filled region is the cap between them. Closing the shape the other way
 * round — arc out, arc back — encloses a sliver a couple of units tall instead,
 * which renders as a bald head with a dark outline. */
const HAIR_CROP = "M61 32 A19 19 0 0 1 99 32 C99 26 91 21 80 21 C69 21 61 26 61 32 Z";
const HAIR_SHORT = "M61 32 A19 19 0 0 1 99 32 C99 24 92 18 80 18 C68 18 61 24 61 32 Z";
const HAIR_WAVY = "M59 33 A21 21 0 0 1 101 33 C101 22 92 16 80 16 C68 16 59 22 59 33 Z";
const HAIR_LONG = "M58 34 A22 22 0 0 1 102 34 C102 21 92 14 80 14 C68 14 58 21 58 34 Z";

/** The locks that fall past the jaw on a longer style. */
const HAIR_SIDES = (
  <>
    <path d="M58 34c-2 10-1 18 2 24-6-9-5-18-2-24z" fill="currentColor" />
    <path d="M102 34c2 10 1 18-2 24 6-9 5-18 2-24z" fill="currentColor" />
  </>
);

/** A name plate sized to its text, for the small tiles where a bare label
 *  would sit unreadably on somebody's shirt. */
function TileName({ name, onDark }: { name: string; onDark?: boolean }) {
  return (
    <g transform="translate(7,42)">
      <rect
        width={26 + name.length * 5}
        height="14"
        rx="5"
        fill={onDark ? "rgba(255,255,255,.16)" : "rgba(9,18,32,.58)"}
      />
      <text x="6" y="10" fill="#fff" fontSize="8.5" fontWeight={500}>
        {name}
      </text>
    </g>
  );
}

/** One person, framed like a webcam: head and shoulders on a 160×92 grid, so
 *  every tile can scale the same drawing to its own size. */
function Bust({
  cloth,
  skin,
  neck,
  hair,
  hairPath,
  talk,
  blink = "home-blink",
  extra,
}: {
  cloth: string;
  skin: string;
  neck: string;
  hair: string;
  hairPath: string;
  /** Animation class for an open mouth, or nothing for a closed smile. */
  talk?: string;
  blink?: string;
  extra?: ReactNode;
}) {
  return (
    <>
      <path d="M27 92c0-25 23-40 53-40s53 15 53 40z" fill={cloth} />
      <rect x="72" y="42" width="16" height="16" rx="7" fill={neck} />
      <circle cx="80" cy="32" r="19" fill={skin} />
      <path d={hairPath} fill={hair} />
      {extra}
      <circle className={blink} cx="73" cy="31" r="2.2" fill="#241811" />
      <circle className={blink} cx="87" cy="31" r="2.2" fill="#241811" />
      {talk ? (
        <ellipse className={talk} cx="80" cy="41" rx="4.3" ry="2.7" fill="#8c4033" />
      ) : (
        <path d="M76 41a6 6 0 0 0 8 0" stroke="#8c4033" strokeWidth={2} fill="none" strokeLinecap="round" />
      )}
    </>
  );
}

/** A tile for somebody whose camera is off — initials, the way the room shows
 *  them. Worth drawing: a grid where everyone is on camera is not a webinar
 *  anybody has been in. */
function AvatarTile({
  x,
  y,
  w,
  h,
  initials,
  name,
  small,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  initials: string;
  name: string;
  small?: boolean;
}) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width={w} height={h} rx={small ? 9 : 10} fill="#1e2a44" />
      <circle cx={w / 2} cy={small ? 27 : 46} r={small ? 15 : 26} fill="#33456b" />
      <text
        x={w / 2}
        y={small ? 32 : 53}
        fill="#c7d6f3"
        fontSize={small ? 11 : 19}
        fontWeight={600}
        textAnchor="middle"
      >
        {initials}
      </text>
      {small ? (
        <TileName name={name} onDark />
      ) : (
        <g transform={`translate(10,${h - 27})`}>
          <rect width="116" height="19" rx="6" fill="rgba(255,255,255,.14)" />
          <text x="9" y="13.5" fill="#fff" fontSize="10" fontWeight={500}>
            {name}
          </text>
        </g>
      )}
    </g>
  );
}

function CallGrid() {
  return (
    <svg
      viewBox="0 0 960 540"
      preserveAspectRatio="xMidYMid meet"
      className="home-call"
      role="img"
      aria-label="A webinar in progress: the host on a large tile, with panelists and audience on smaller tiles around it"
    >
      <defs>
        <clipPath id="home-clip-host">
          <rect x="0" y="0" width="592" height="333" rx="13" />
        </clipPath>
        <clipPath id="home-clip-panel">
          <rect x="0" y="0" width="312" height="103" rx="10" />
        </clipPath>
        <clipPath id="home-clip-aud">
          <rect x="0" y="0" width="118" height="62" rx="9" />
        </clipPath>
        <linearGradient id="home-room-a" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dbeafe" />
          <stop offset="1" stopColor="#f4f8ff" />
        </linearGradient>
        <linearGradient id="home-room-b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e0f2fe" />
          <stop offset="1" stopColor="#f2fbff" />
        </linearGradient>
        <linearGradient id="home-room-c" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ede9fe" />
          <stop offset="1" stopColor="#f7f5ff" />
        </linearGradient>
        <linearGradient id="home-room-d" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ccfbf1" />
          <stop offset="1" stopColor="#f0fdfa" />
        </linearGradient>
        <linearGradient id="home-room-e" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fef3c7" />
          <stop offset="1" stopColor="#fffcf0" />
        </linearGradient>
        <linearGradient id="home-room-f" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fce7f3" />
          <stop offset="1" stopColor="#fef6fb" />
        </linearGradient>
        <linearGradient id="home-room-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2e8f0" />
          <stop offset="1" stopColor="#f6f9fc" />
        </linearGradient>
      </defs>

      {/* ---------------- host: the big tile ---------------- */}
      <g transform="translate(20,52)">
        <rect width="592" height="333" rx="13" fill="url(#home-room-a)" />
        <g clipPath="url(#home-clip-host)">
          {/* a wall behind them, so the tile is a room and not a backdrop */}
          <rect x="392" y="40" width="168" height="112" rx="9" fill="#fff" opacity="0.55" />
          <rect x="410" y="60" width="62" height="7" rx="3.5" fill="#c3d6f2" />
          <rect x="410" y="76" width="110" height="7" rx="3.5" fill="#dce7f7" />
          <rect x="410" y="92" width="86" height="7" rx="3.5" fill="#dce7f7" />
          <circle cx="86" cy="92" r="42" fill="#fff" opacity="0.4" />
          {/* Scaled to webcam framing — head about a third of the tile, with
              headroom — and anchored to the bottom edge, rather than stretched
              to fill the tile, which crops the top of the head off. */}
          <g transform="translate(56,57) scale(3)">
            <g className="home-nod">
              <Bust
                cloth="#2563eb"
                skin="#e4a877"
                neck="#c98f66"
                hair="#2f2016"
                hairPath={HAIR_SHORT}
                talk="home-talk"
                extra={<path d="M64 52h32l-16 15z" fill="#fff" opacity="0.85" />}
              />
            </g>
          </g>
          <rect className="home-ring" x="2" y="2" width="588" height="329" rx="12" fill="none" stroke="#22c55e" strokeWidth={3} />
        </g>
        <g transform="translate(16,295)">
          <rect width="152" height="26" rx="8" fill="rgba(9,18,32,.62)" />
          <g transform="translate(11,8)">
            <path d="M5 0a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V3a3 3 0 0 1 3-3Z" fill="#4ade80" />
            <path d="M0 7a5 5 0 0 0 10 0M5 12v2" stroke="#4ade80" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          </g>
          <text x="32" y="17.5" fill="#fff" fontSize="12" fontWeight={500}>
            Ananya · Host
          </text>
        </g>
        <g transform="translate(552,300)">
          <rect className="home-lv home-lv-1" x="0" y="0" width="4" height="16" rx="2" fill="#4ade80" />
          <rect className="home-lv home-lv-2" x="7" y="0" width="4" height="16" rx="2" fill="#4ade80" />
          <rect className="home-lv home-lv-3" x="14" y="0" width="4" height="16" rx="2" fill="#4ade80" />
        </g>
      </g>

      {/* ---------------- panelists: the column ---------------- */}
      <g transform="translate(624,52)">
        <rect width="312" height="103" rx="10" fill="url(#home-room-d)" />
        <g clipPath="url(#home-clip-panel)">
          <g transform="translate(66,0) scale(1.12)">
            <g className="home-nod">
              <Bust
                cloth="#0d9488"
                skin="#8d5524"
                neck="#b97a53"
                hair="#1b1410"
                hairPath={HAIR_WAVY}
                talk="home-talk-b"
                blink="home-blink-b"
                extra={<path d="M66 40c3 9 8 13 14 13s11-4 14-13c-4 5-9 7-14 7s-10-2-14-7z" fill="#1b1410" />}
              />
            </g>
          </g>
          <rect className="home-ring" x="1.5" y="1.5" width="309" height="100" rx="9" fill="none" stroke="#22c55e" strokeWidth={3} />
        </g>
        <g transform="translate(10,76)">
          <rect width="108" height="19" rx="6" fill="rgba(9,18,32,.6)" />
          <text x="9" y="13.5" fill="#fff" fontSize="10" fontWeight={500}>
            Rahul · Panelist
          </text>
        </g>
      </g>

      <g transform="translate(624,167)">
        <rect width="312" height="103" rx="10" fill="url(#home-room-c)" />
        <g clipPath="url(#home-clip-panel)">
          <g transform="translate(66,0) scale(1.12)">
            <Bust
              cloth="#7c3aed"
              skin="#f3c095"
              neck="#dfa87e"
              hair="#3f2d23"
              hairPath={HAIR_LONG}
              extra={<g style={{ color: "#3f2d23" }}>{HAIR_SIDES}</g>}
            />
          </g>
        </g>
        <g transform="translate(10,76)">
          <rect width="112" height="19" rx="6" fill="rgba(9,18,32,.6)" />
          <text x="9" y="13.5" fill="#fff" fontSize="10" fontWeight={500}>
            Meera · Panelist
          </text>
        </g>
        <g transform="translate(286,12)">
          <rect x="-6" y="-6" width="24" height="24" rx="7" fill="rgba(9,18,32,.55)" />
          <path d="M0 0l12 12M6 0a3 3 0 0 1 3 3v2M3 5v2a3 3 0 0 0 4.4 2.6" stroke="#fb7185" strokeWidth={1.8} fill="none" strokeLinecap="round" />
        </g>
      </g>

      <AvatarTile x={624} y={282} w={312} h={103} initials="AR" name="Arjun · Panelist" />

      {/* ---------------- audience: the strip ---------------- */}
      <g transform="translate(20,397)">
        <g transform="translate(0,0)">
          <rect width="118" height="62" rx="9" fill="url(#home-room-b)" />
          <g clipPath="url(#home-clip-aud)">
            <g transform="translate(2,0) scale(.674)">
              <Bust cloth="#0284c7" skin="#e4a877" neck="#c98f66" hair="#20160f" hairPath={HAIR_CROP} />
            </g>
          </g>
          <TileName name="Dev" />
        </g>

        <g transform="translate(130,0)">
          <rect width="118" height="62" rx="9" fill="url(#home-room-f)" />
          <g clipPath="url(#home-clip-aud)">
            <g transform="translate(2,0) scale(.674)">
              <Bust cloth="#db2777" skin="#f3c095" neck="#dfa87e" hair="#6b3f1d" hairPath={HAIR_LONG} blink="home-blink-b" />
            </g>
          </g>
          <TileName name="Sana" />
        </g>

        <g transform="translate(260,0)">
          <rect width="118" height="62" rx="9" fill="url(#home-room-e)" />
          <g clipPath="url(#home-clip-aud)">
            <g transform="translate(2,0) scale(.674)">
              <Bust cloth="#ea580c" skin="#c98f66" neck="#a86b45" hair="#141010" hairPath={HAIR_CROP} talk="home-talk" />
            </g>
          </g>
          <TileName name="Karan" />
        </g>

        <g transform="translate(390,0)">
          <rect width="118" height="62" rx="9" fill="url(#home-room-d)" />
          <g clipPath="url(#home-clip-aud)">
            <g transform="translate(2,0) scale(.674)">
              <Bust cloth="#0f766e" skin="#8d5524" neck="#b97a53" hair="#171210" hairPath={HAIR_WAVY} blink="home-blink-b" />
            </g>
          </g>
          <TileName name="Zoya" />
        </g>

        <g transform="translate(520,0)">
          <rect width="118" height="62" rx="9" fill="url(#home-room-g)" />
          <g clipPath="url(#home-clip-aud)">
            <g transform="translate(2,0) scale(.674)">
              <Bust cloth="#475569" skin="#f3c095" neck="#dfa87e" hair="#8a6f4e" hairPath={HAIR_SHORT} />
            </g>
          </g>
          <TileName name="Liam" />
        </g>

        <AvatarTile x={650} y={0} w={118} h={62} initials="NK" name="Nikhil" small />

        <g transform="translate(780,0)">
          <rect width="118" height="62" rx="9" fill="rgba(255,255,255,.09)" stroke="rgba(255,255,255,.16)" strokeWidth={1.4} />
          <text x="59" y="29" fill="#fff" fontSize="16" fontWeight={600} textAnchor="middle">
            +1,272
          </text>
          <text x="59" y="45" fill="rgba(255,255,255,.62)" fontSize="9" textAnchor="middle">
            in the audience
          </text>
        </g>
      </g>
    </svg>
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

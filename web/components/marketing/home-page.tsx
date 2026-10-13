"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { HomeLegalFooter, SUPPORT_EMAIL } from "@/components/marketing/legal-page";
import { useSession } from "@/components/providers";
import { appHome } from "@/lib/access";
import "@/app/landing.css";

/* Public marketing home for Webinar Liv, aimed at coaches, teachers and course
 * creators.
 *
 * Every claim is a feature that ships today. Prices, results figures and a trial
 * offer are left out until there is billing behind them. Signed-in visitors are
 * redirected away (see middleware + SignedInHomeRedirect); this page is for
 * logged-out guests.
 *
 * One sample webinar runs through the page: 120 registered, 85 attended, and Neha
 * scores 92. Her breakdown is the real formula in web/lib/engagement/score.ts with
 * every tool used: 38.7 + 15 + 10 + 10 + 6 + 2 + 5 + 5 = 91.7, rounded once to 92.
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
    router.replace(appHome(account.canHost));
  }, [account, status, router]);

  return null;
}

export function HomePage() {
  const root = useReveal();

  return (
    <div className="home">
      <div ref={root} className="lp">
        <Hero />
        <Audience />
        <HowItWorks />
        <EngagementScore />
        <Faq />
        <FinalCta />
      </div>
      <HomeLegalFooter />
    </div>
  );
}

/* Content fades in as it scrolls into view. Nothing is hidden until this runs —
 * `.lp-js` is what arms the hidden state — so the page reads in full without JS. */
function useReveal() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reveals = [...el.querySelectorAll<HTMLElement>(".reveal")];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) {
      for (const r of reveals) r.classList.add("in");
      return;
    }
    el.classList.add("lp-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    for (const r of reveals) io.observe(r);
    return () => io.disconnect();
  }, []);

  return root;
}

// ------------------------------------------------------------------ hero

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden />
      <div className="wrap">
        <div className="hero-copy">
          <p className="pill reveal">
            <Icon name="sparkles" /> Built for coaches, teachers &amp; course creators
          </p>
          <h1 id="hero-title" className="h1 reveal">
            Turn webinars into your
            <br className="br-lg" /> <em className="grad-text">lead conversion engine</em>
          </h1>
          <p className="hero-lede reveal">
            Reminders that fill the room, a score for every attendee, and follow‑up that goes
            out minutes after you end.
          </p>
          <div className="cta-row reveal">
            <Link className="btn btn-primary btn-lg" href="/signup">
              Start free <Icon name="arrow-right" />
            </Link>
            <Link className="btn btn-ghost btn-lg" href="/browse">
              Join a webinar
            </Link>
          </div>
          <ul className="checks reveal">
            <li>
              <Icon name="check" /> No download for attendees
            </li>
            <li>
              <Icon name="check" /> Set up in minutes
            </li>
            <li>
              <Icon name="check" /> Self-hosted and private
            </li>
          </ul>
        </div>

        <div
          className="hero-visual reveal"
          role="img"
          aria-label="A live Webinar Liv room with 85 watching and a poll running. Beside it: a WhatsApp reminder delivered to 112 of 120 registrants, and Neha Verma scored 92 and asking how to join the program."
        >
          <LiveRoom />
          <article className="fcard hv-float hv-left">
            <header className="fcard-head">
              <span className="stage-tag">Before</span>
              <span className="fcard-time">1 hr to go</span>
            </header>
            <div className="fcard-row">
              <WhatsAppGlyph />
              <div>
                <b>Reminder delivered</b>
                <small>112 of 120 registrants</small>
              </div>
            </div>
            <p className="fcard-wa">
              “We go live in 1 hour — tap to join.”
              <span className="fcard-wa-meta">
                5:30 PM <ReadTicks />
              </span>
            </p>
          </article>
          <article className="fcard fcard-win hv-float hv-right">
            <header className="fcard-head">
              <span className="stage-tag">After</span>
              <span className="fcard-time">+12 min</span>
            </header>
            <div className="fcard-row">
              <span className="avatar av-1">NV</span>
              <div>
                <b>“How do I join?”</b>
                <small>Neha Verma · score 92</small>
              </div>
            </div>
            <div className="fcard-chips">
              <span className="chip chip-hot">
                <Icon name="flame" /> Hot lead
              </span>
              <span className="chip chip-ok">
                <Icon name="check" /> Enrolled
              </span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* Real people, not an illustration: Pexels photos (free to use, no attribution
 * required) served from this app, pre-sized at the source for this layout. */
function LiveRoom() {
  return (
    <div className="room">
      <div className="room-top">
        <span className="badge-live">
          <i />
          LIVE
        </span>
        <span className="room-title">Scale your coaching practice without burning out</span>
        <span className="room-watch">
          <Icon name="eye" /> 85 watching
        </span>
      </div>
      <div className="room-body">
        <div className="room-stage">
          <div className="tile tile-host">
            <Photo src="/images/hero/host.jpg" />
            <span className="tile-name">
              <Icon name="mic" /> Arjun Mehta · Host
            </span>
            <span className="tile-level">
              <i />
              <i />
              <i />
            </span>
            <div className="reactions">
              {["👏", "❤️", "🎉", "👍"].map((emoji, i) => (
                <span key={emoji} style={{ "--i": i } as CSSProperties}>
                  {emoji}
                </span>
              ))}
            </div>
          </div>
          <div className="tile-side">
            <div className="tile">
              <Photo src="/images/hero/panelist-1.jpg" />
              <span className="tile-name">Shweta · Panelist</span>
            </div>
            <div className="tile">
              <Photo src="/images/hero/panelist-2.jpg" />
              <span className="tile-name">Rohan · On stage</span>
            </div>
          </div>
          <div className="tile-strip">
            <div className="tile">
              <Photo src="/images/hero/audience-1.jpg" />
            </div>
            <div className="tile">
              <Photo src="/images/hero/audience-2.jpg" />
            </div>
            <div className="tile tile-initials">NV</div>
            <div className="tile tile-more">
              <b>+82</b>watching
            </div>
          </div>
        </div>
        <div className="room-panel">
          <div className="panel-tabs">
            <span>Chat</span>
            <span>Q&amp;A</span>
            <span className="on">Polls</span>
          </div>
          <Poll
            kicker="Live poll"
            options={[
              ["Finding clients", 46],
              ["Pricing", 24],
              ["Time / burnout", 18],
              ["Systems & tools", 12],
            ]}
            foot="72 of 85 voted"
          />
          <div className="qa">
            <span className="qa-votes">
              <Icon name="up" />
              14
            </span>
            <div>
              <p>How do I price a group program?</p>
              <small>Rohan D. · 2 min ago</small>
            </div>
          </div>
        </div>
      </div>
      <div className="room-bar">
        <span className="rb">
          <Icon name="mic" />
        </span>
        <span className="rb">
          <Icon name="video" />
        </span>
        <span className="rb">
          <Icon name="screen" />
        </span>
        <span className="rb rb-rec">
          <i />
          REC 52:10
        </span>
        <span className="rb">
          <Icon name="hand" />3
        </span>
        <span className="rb rb-end">End</span>
      </div>
    </div>
  );
}

function Poll({
  kicker,
  options,
  foot,
}: {
  kicker: string;
  options: [string, number][];
  foot?: string;
}) {
  return (
    <div className="poll">
      <p className="poll-kicker">
        <Icon name="poll" /> {kicker}
      </p>
      <p className="poll-q">What&apos;s your biggest challenge right now?</p>
      <ul className="poll-opts">
        {options.map(([label, pct], i) => (
          <li key={label} className={i === 0 ? "lead" : undefined} style={{ "--v": `${pct}%` } as CSSProperties}>
            <span>{label}</span>
            <b>{pct}%</b>
          </li>
        ))}
      </ul>
      {foot && <p className="poll-foot">{foot}</p>}
    </div>
  );
}

function Photo({ src }: { src: string }) {
  // Pre-sized and compressed at the source; next/image would redo that work.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="eager" />;
}

// ------------------------------------------------------------------ audience

function Audience() {
  return (
    <section className="audience" aria-label="Who uses Webinar Liv">
      <div className="wrap audience-inner reveal">
        <p>Built for people who teach, coach and sell online</p>
        <ul className="audience-list">
          <li>Business coaches</li>
          <li>Fitness &amp; yoga trainers</li>
          <li>Language teachers</li>
          <li>Test-prep academies</li>
          <li>Course creators</li>
        </ul>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ how it works

function HowItWorks() {
  return (
    <section className="section steps" id="how-it-works" aria-labelledby="steps-title">
      <div className="wrap">
        <div className="section-head reveal">
          <p className="eyebrow">How it works</p>
          <h2 id="steps-title" className="h2">
            One tool for before, during <em>and after</em>
          </h2>
          <p className="lede">
            Most webinar apps only cover the hour you&apos;re live. Webinar Liv runs the days
            around it — where leads are won or lost.
          </p>
        </div>

        <div className="step-grid">
          <article className="step-card reveal">
            <div className="step-vis" aria-hidden>
              <div className="sv-link">
                <Icon name="link" />
                <span>webinarliv.com/webinars/scale-your-coaching</span>
              </div>
              <div className="sv-wa">
                <WhatsAppGlyph />
                <p>
                  Hi Neha 👋 We go live in <b>1 hour</b>. Tap to join — no app needed.
                </p>
              </div>
              <div className="sv-stat">
                <b>112</b> of 120 reminders delivered
              </div>
            </div>
            <StepKicker n="01" label="Before" />
            <h3>Fill the room</h3>
            <Ticks
              items={[
                "Registration page with your own questions",
                "Email and WhatsApp reminders",
                "One tap to join — nothing to download",
              ]}
            />
          </article>

          <article className="step-card reveal">
            <div className="step-vis sv-dark" aria-hidden>
              <Poll
                kicker="Live poll · 72 voted"
                options={[
                  ["Finding clients", 46],
                  ["Pricing", 24],
                  ["Time / burnout", 18],
                ]}
              />
            </div>
            <StepKicker n="02" label="During" />
            <h3>Keep them engaged</h3>
            <Ticks
              items={[
                "Polls, quizzes and upvoted Q&A",
                "Chat, reactions and raised hands",
                "Record, or stream to YouTube",
              ]}
            />
          </article>

          <article className="step-card reveal">
            <div className="step-vis" aria-hidden>
              <ul className="sv-groups">
                <li>
                  <i className="dot dot-high" />
                  <span>Highly engaged</span>
                  <b>24</b>
                  <em className="sv-btn primary">Send offer</em>
                </li>
                <li>
                  <i className="dot dot-engaged" />
                  <span>Engaged</span>
                  <b>31</b>
                  <em className="sv-btn">Send replay</em>
                </li>
                <li>
                  <i className="dot dot-noshow" />
                  <span>No-shows</span>
                  <b>35</b>
                  <em className="chip chip-ok">
                    <Icon name="check" /> Sent
                  </em>
                </li>
              </ul>
            </div>
            <StepKicker n="03" label="After" />
            <h3>Follow up in minutes</h3>
            <Ticks
              items={[
                "Every attendee scored 0–100",
                "The right message for each group",
                "Drips, chatbot and one shared inbox",
              ]}
            />
          </article>
        </div>
      </div>
    </section>
  );
}

function StepKicker({ n, label }: { n: string; label: string }) {
  return (
    <p className="step-kicker">
      <span>{n}</span> {label}
    </p>
  );
}

function Ticks({ items }: { items: string[] }) {
  return (
    <ul className="ticks">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ engagement score

const SCORE_PARTS: { name: string; detail: string; pts: number; max: number }[] = [
  { name: "Watch time", detail: "58 of 60 min", pts: 38.7, max: 40 },
  { name: "Polls answered", detail: "2 of 2 answered", pts: 15, max: 15 },
  { name: "Quiz accuracy", detail: "2 of 2 correct", pts: 10, max: 10 },
  { name: "Chat", detail: "5 messages (cap 5)", pts: 10, max: 10 },
  { name: "Q&A", detail: "1 asked · 1 upvote", pts: 6, max: 10 },
  { name: "Reactions", detail: "4 (cap 10)", pts: 2, max: 5 },
  { name: "Raised hand", detail: "Yes", pts: 5, max: 5 },
  { name: "Survey", detail: "Completed", pts: 5, max: 5 },
];

function EngagementScore() {
  return (
    <section className="section score" id="engagement-score" aria-labelledby="score-title">
      <div className="score-glow" aria-hidden />
      <div className="wrap score-split">
        <div className="score-copy reveal">
          <p className="eyebrow">Engagement Score</p>
          <h2 id="score-title" className="h2">
            See who&apos;s ready to buy <em>before you say goodbye</em>
          </h2>
          <p className="lede">
            Every attendee gets a score from 0 to 100, built from what they actually did. Points
            are capped, so nobody can fake it.
          </p>
          <ul className="score-points">
            <ScorePoint icon="target" title="Eight real signals">
              Watch time, polls, quizzes, chat, Q&amp;A, reactions, hands and survey.
            </ScorePoint>
            <ScorePoint icon="shield" title="Fair by design">
              Didn&apos;t run a quiz? Its points are shared across the rest.
            </ScorePoint>
            <ScorePoint icon="download" title="Yours to export">
              Attendance and scores as CSV, any time.
            </ScorePoint>
          </ul>
        </div>

        <article className="app-card person reveal">
          <header className="person-head">
            <span className="avatar av-1 lg">NV</span>
            <div>
              <b>Neha Verma</b>
              <small>Attended 58 of 60 min</small>
            </div>
            <div className="ring" role="img" aria-label="Score 92 out of 100">
              <span>
                <b>92</b>
                <small>of 100</small>
              </span>
            </div>
          </header>
          <p className="tier-chip">
            <i className="dot dot-high" /> Highly engaged · score 75+
          </p>
          <ul className="parts" aria-label="How Neha's score adds up">
            {SCORE_PARTS.map((part) => (
              <li key={part.name}>
                <span className="part-name">{part.name}</span>
                <span className="part-detail">{part.detail}</span>
                <span className="meter">
                  <i style={{ "--f": `${(part.pts / part.max) * 100}%` } as CSSProperties} />
                </span>
                <span className="part-pts">
                  {part.pts}
                  <small>/{part.max}</small>
                </span>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}

function ScorePoint({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
}) {
  return (
    <li>
      <span className="sp-ic">
        <Icon name={icon} />
      </span>
      <div>
        <b>{title}</b>
        <p>{children}</p>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ faq

function Faq() {
  return (
    <section className="section faq" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div className="faq-head reveal">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title" className="h2">
            Questions coaches <em>ask us</em>
          </h2>
          <p className="lede">
            Something else? Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </p>
        </div>
        <div className="faq-list reveal">
          <FaqItem open question="Do my attendees need to download anything?">
            No. They join from the browser on a phone or laptop — one tap on the reminder takes
            them straight into the room.
          </FaqItem>
          <FaqItem question="How do WhatsApp reminders work?">
            Connect your WhatsApp Business number through Meta&apos;s official sign-up. Attendees
            opt in on your registration page, and reminders go out at the times you choose.
            Replies land in your inbox.
          </FaqItem>
          <FaqItem question="What is the Engagement Score?">
            A 0–100 score per attendee: watch time (40), polls (15), quiz accuracy (10), chat
            (10), Q&amp;A (10), reactions (5), raised hand (5) and survey (5). Points are capped,
            and tools you didn&apos;t use don&apos;t count against anyone.
          </FaqItem>
          <FaqItem question="Do I own my contacts and data?">
            Always. Export registrants, attendance and chat as CSV whenever you like.
          </FaqItem>
        </div>
      </div>
    </section>
  );
}

function FaqItem({
  question,
  open,
  children,
}: {
  question: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open}>
      <summary>
        {question} <Icon name="chevron" />
      </summary>
      <p>{children}</p>
    </details>
  );
}

// ------------------------------------------------------------------ final cta

function FinalCta() {
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="final-glow" aria-hidden />
      <div className="wrap final-inner reveal">
        <h2 id="final-title" className="h2">
          Your next webinar could be <em>your best sales day</em>
        </h2>
        <div className="cta-row">
          <Link className="btn btn-white btn-lg" href="/signup">
            Start free <Icon name="arrow-right" />
          </Link>
          <Link className="btn btn-outline-light btn-lg" href="/browse">
            Browse webinars
          </Link>
        </div>
        <ul className="checks on-dark">
          <li>
            <Icon name="check" /> No download for attendees
          </li>
          <li>
            <Icon name="check" /> Your contacts, exportable any time
          </li>
        </ul>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ icons

const ICONS = {
  check: <path d="M20 6 9 17l-5-5" />,
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 3v4M17 5h4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </>
  ),
  video: (
    <>
      <path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  screen: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  poll: (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 17v-5" />
      <path d="M13 17V7" />
      <path d="M18 17v-4" />
    </>
  ),
  up: <path d="m6 15 6-6 6 6" />,
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
} satisfies Record<string, ReactNode>;

type IconName = keyof typeof ICONS;

function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

function WhatsAppGlyph() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" aria-hidden>
      <path fill="#25D366" d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.9 5-1.3A9.8 9.8 0 1 0 12 2.2z" />
      <path
        fill="#fff"
        d="M17 14.3c-.3-.1-1.6-.8-1.9-.9s-.4-.1-.6.1-.7.9-.9 1.1-.3.2-.6.1a7.8 7.8 0 0 1-2.3-1.4 8.7 8.7 0 0 1-1.6-2c-.2-.3 0-.4.1-.6l.4-.5.3-.5a.5.5 0 0 0 0-.5L9 7.4c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5.1 5.1 0 0 0 1.1 2.7 11.6 11.6 0 0 0 4.4 3.9c.6.3 1.1.4 1.5.6a3.6 3.6 0 0 0 1.6.1 2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.6-.3z"
      />
    </svg>
  );
}

function ReadTicks() {
  return (
    <svg className="ticks-svg" viewBox="0 0 18 12" aria-hidden>
      <path
        d="M1 6.6 4.1 9.7 10.6 2.4M7.6 9.5l.3.3 6.4-7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

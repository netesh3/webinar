/* The PROPOSED plans: one typed source for the /features page and the proposed pricing
 * page, so the two cannot disagree. See docs/pricing-proposal.md for the costs behind
 * every number.
 *
 * NOT what checkout charges. Live billing is api/internal/billing/billing.go (Plans) and
 * api/types/types.go (PlanAttendeeCap, PlanStageCap, PlanMeetingCap) plus the plan_limits
 * table (migration 0148); the /pricing page reads those through GET /api/billing/plans.
 * While PLANS_STATUS is "proposal" the pages built on this file are marked noindex, carry a
 * "proposed pricing" note, and link to the live /pricing for buying. Flip it to "live" only
 * after the server's table matches this one.
 *
 * Pure: no React, no DOM, so it runs under node tests (lib/plans.test.mts). */

export type PlansStatus = "proposal" | "live";
export const PLANS_STATUS: PlansStatus = "proposal";

export type Currency = "INR" | "USD";
export type Period = "monthly" | "yearly";
export type PlanId = "starter" | "pro" | "business" | "enterprise";

/** The server's plan id each proposed tier would replace (types.Plan), for the migration list. */
export type ServerPlan = "professional" | "business" | "enterprise";

export type PlanLimits = {
  /** Concurrent attendees in one webinar. */
  attendees: number;
  /** Attendee-hours a month included: one person watching for one hour is one. */
  attendeeHours: number;
  /** People on a webinar stage at once, the host included. */
  stage: number;
  /** People in one meeting at once, the host included. */
  meetingCap: number;
  /** Cloud recording storage, GB. */
  recordingGb: number;
  /** Days a recording is kept before "Keep longer" is needed. */
  retentionDays: number;
  /** AI credits a month (see AI_CREDIT_COSTS). 0: AI is an add-on on this plan. */
  aiCredits: number;
  /** Clip and reel videos rendered a month. */
  clipRenders: number;
};

export type Plan = {
  id: PlanId;
  server: ServerPlan | null;
  name: string;
  who: string;
  /** Whole currency units a month, before GST. Null: contact us. */
  monthly: Record<Currency, number> | null;
  popular?: boolean;
  /** Null limits on Enterprise read "Custom". */
  limits: PlanLimits | null;
  /** The card's short list, after the limits it shows itself. */
  highlights: string[];
};

export const PLANS: Plan[] = [
  {
    id: "starter",
    server: "professional",
    name: "Starter",
    who: "For coaches running their first programs",
    monthly: { INR: 3999, USD: 49 },
    limits: {
      attendees: 200,
      attendeeHours: 2500,
      stage: 3,
      meetingCap: 10,
      recordingGb: 10,
      retentionDays: 30,
      aiCredits: 0,
      clipRenders: 0,
    },
    highlights: [
      "Webinars, meetings and simulive",
      "Registration pages, email reminders and push",
      "Polls, quizzes, Q&A, whiteboard and captions",
      "Engagement Score and CSV export",
      "AI available as an add-on",
    ],
  },
  {
    id: "pro",
    server: "business",
    name: "Pro",
    who: "For coaches selling programs every week",
    monthly: { INR: 9999, USD: 149 },
    popular: true,
    limits: {
      attendees: 500,
      attendeeHours: 10000,
      stage: 5,
      meetingCap: 10,
      recordingGb: 50,
      retentionDays: 90,
      aiCredits: 1000,
      clipRenders: 30,
    },
    highlights: [
      "Everything in Starter",
      "AI recaps, Q&A answers and follow-up drafts",
      "WhatsApp reminders, broadcasts and inbox",
      "Highlights, reels and Studio",
      "Stream to YouTube and social, and Zoom",
    ],
  },
  {
    id: "business",
    server: "enterprise",
    name: "Business",
    who: "For academies and teams with big launches",
    monthly: { INR: 24999, USD: 349 },
    limits: {
      attendees: 1000,
      attendeeHours: 25000,
      stage: 10,
      meetingCap: 25,
      recordingGb: 200,
      retentionDays: 365,
      aiCredits: 5000,
      clipRenders: 100,
    },
    highlights: [
      "Everything in Pro",
      "Meetings of up to 25 people",
      "Recordings kept for a year",
      "Priority support on WhatsApp",
      "Personal onboarding session",
    ],
  },
  {
    id: "enterprise",
    server: null,
    name: "Enterprise",
    who: "For institutions and very large audiences",
    monthly: null,
    limits: null,
    highlights: [
      "More than 1,000 attendees",
      "Custom retention and storage",
      "A dedicated video server",
      "Annual invoice and a written agreement",
    ],
  },
];

export const TRIAL = {
  days: 7,
  /** A trial gets this plan's limits (the server: limits_plan, migration 0148). */
  plan: "pro" as PlanId,
  aiCredits: 200,
  /** The server only offers the trial in INR today (BillingCatalogue.trialCurrency). */
  currency: "INR" as Currency,
};

/** Yearly is ten months for the price of twelve. */
export const FREE_MONTHS_YEARLY = 2;

/** GST added to INR prices at checkout (BILLING_GST_PERCENT). */
export const GST_PERCENT = 18;

export function findPlan(id: PlanId): Plan {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown plan ${id}`);
  return p;
}

/** Plans sold online, in order. */
export function selfServePlans(): Plan[] {
  return PLANS.filter((p) => p.monthly !== null);
}

/* The yearly price, in whole units: the server's rule (billing.yearly) so the page and the
 * charge agree. USD is ten months. INR is twelve months at a whole per-month figure ending
 * in 9, rounded down from ten-twelfths of the monthly price: never more than ten months. */
export function yearlyPrice(monthly: number, currency: Currency): number {
  if (currency !== "INR") return monthly * 10;
  let perMonth = Math.floor((monthly * 10) / 12);
  perMonth -= (((perMonth - 9) % 10) + 10) % 10;
  return perMonth * 12;
}

/** What one period costs, before GST, or null for a contact-only plan. */
export function priceFor(plan: Plan, currency: Currency, period: Period): number | null {
  if (!plan.monthly) return null;
  const m = plan.monthly[currency];
  return period === "yearly" ? yearlyPrice(m, currency) : m;
}

/** The headline per-month figure: the yearly price spread over twelve months. */
export function perMonth(plan: Plan, currency: Currency, period: Period): number | null {
  const p = priceFor(plan, currency, period);
  if (p === null) return null;
  return period === "yearly" ? Math.round(p / 12) : p;
}

/** The yearly saving against twelve monthly payments, whole percent. */
export function yearlySavingPercent(plan: Plan, currency: Currency): number {
  if (!plan.monthly) return 0;
  const twelve = plan.monthly[currency] * 12;
  return Math.round(((twelve - yearlyPrice(plan.monthly[currency], currency)) / twelve) * 100);
}

export function formatPrice(amount: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** GST on an INR amount; USD buyers pay from outside India and are not charged it. */
export function gstOn(amount: number, currency: Currency): number {
  return currency === "INR" ? Math.round((amount * GST_PERCENT) / 100) : 0;
}

/* AI credits: one unit for every AI feature, so a host sees one allowance, not seven.
 * Priced from the model costs in lib/cost-calculator.ts (gpt-5-nano for most, gpt-5-mini for
 * clips): a credit costs us at most ~$0.001, so 1,000 credits is under a dollar of model
 * spend. Indexing the knowledge base and the rules-based spam filter use none. */
export const AI_CREDIT_COSTS: { action: string; credits: number; per: string }[] = [
  { action: "Recap, chapters and insights", credits: 10, per: "session hour" },
  { action: "Q&A answer draft or auto-mode answer", credits: 1, per: "answer" },
  { action: "Q&A grouping and hot-lead scoring", credits: 5, per: "session" },
  { action: "Follow-up draft (email or WhatsApp)", credits: 1, per: "attendee" },
  { action: "Repurpose: blog, newsletter or social post", credits: 5, per: "draft" },
  { action: "Write with AI: a title, description or post", credits: 1, per: "draft" },
  { action: "Highlights and reel plan", credits: 10, per: "recording hour" },
];

export type AddOn = { id: string; name: string; detail: string; price: Record<Currency, number>; per: string };

export const ADD_ONS: AddOn[] = [
  {
    id: "ai",
    name: "AI add-on for Starter",
    detail: "500 AI credits a month and the AI knowledge base",
    price: { INR: 799, USD: 9 },
    per: "month",
  },
  {
    id: "ai-credits",
    name: "Extra AI credits",
    detail: "1,000 credits, used after the plan's own",
    price: { INR: 399, USD: 5 },
    per: "pack",
  },
  {
    id: "attendee-hours",
    name: "Extra attendee-hours",
    detail: "5,000 attendee-hours, valid for the billing month",
    price: { INR: 2999, USD: 39 },
    per: "pack",
  },
  {
    id: "storage",
    name: "Extra recording storage",
    detail: "50 GB more for recordings and clips",
    price: { INR: 299, USD: 4 },
    per: "month",
  },
  {
    id: "clips",
    name: "Extra clip renders",
    detail: "20 more highlight or reel videos",
    price: { INR: 499, USD: 7 },
    per: "pack",
  },
];

/* ------------------------------------------------------------------ comparison table */

/** A cell: included, not included, or a limit to print. */
export type Cell = boolean | string;

export type CompareRow = {
  label: string;
  /** A short note under the label in the table. */
  hint?: string;
  /** A sentence for the /features page; rows without one are table-only. */
  detail?: string;
  cells: Record<PlanId, Cell>;
};

export type CompareGroup = {
  id: string;
  title: string;
  /** The /features section's one-line intro; groups without one are table-only. */
  intro?: string;
  rows: CompareRow[];
};

export const PLAN_IDS: PlanId[] = ["starter", "pro", "business", "enterprise"];

function n(v: number): string {
  return v.toLocaleString("en-IN");
}

/** A limit row read from PLANS, so the table can never disagree with the cards. */
function limitRow(label: string, pick: (l: PlanLimits) => Cell, hint?: string, custom: Cell = "Custom"): CompareRow {
  const cells = {} as Record<PlanId, Cell>;
  for (const id of PLAN_IDS) {
    const l = findPlan(id).limits;
    cells[id] = l ? pick(l) : custom;
  }
  return { label, hint, cells };
}

type RowText = { hint?: string; detail?: string };

/** Same on every plan. */
function all(label: string, text: RowText = {}): CompareRow {
  return { label, ...text, cells: { starter: true, pro: true, business: true, enterprise: true } };
}

/** From one plan up. */
function from(first: PlanId, label: string, text: RowText = {}): CompareRow {
  const at = PLAN_IDS.indexOf(first);
  const cells = {} as Record<PlanId, Cell>;
  PLAN_IDS.forEach((id, i) => (cells[id] = i >= at));
  return { label, ...text, cells };
}

/** An AI feature: Starter buys the AI add-on, every other plan has it with its credits. */
function ai(label: string, text: RowText = {}): CompareRow {
  return { label, ...text, cells: { starter: ADD_ON_CELL, pro: true, business: true, enterprise: true } };
}

/** The cell an AI feature shows on Starter. */
export const ADD_ON_CELL = "Add-on";

export const COMPARISON: CompareGroup[] = [
  {
    id: "limits",
    title: "Limits",
    rows: [
      limitRow("Attendees per webinar", (l) => n(l.attendees), "Live at once", "1,000+"),
      limitRow(
        "Attendee-hours a month",
        (l) => n(l.attendeeHours),
        "One person watching for one hour. Top up with packs.",
      ),
      limitRow("People on stage", (l) => String(l.stage), "Host, co-hosts and panelists together"),
      limitRow("People per meeting", (l) => String(l.meetingCap), undefined, "Up to 50"),
      limitRow("Recording storage", (l) => `${n(l.recordingGb)} GB`),
      limitRow("Recordings kept for", (l) => `${l.retentionDays} days`, "Then Keep longer, 3 months at a time"),
      limitRow("AI credits a month", (l) => (l.aiCredits ? n(l.aiCredits) : ADD_ON_CELL)),
      limitRow("Clip and reel renders a month", (l) => (l.clipRenders ? n(l.clipRenders) : false)),
    ],
  },
  {
    id: "live",
    title: "Run live sessions",
    intro: "Webinars, meetings and simulive in the browser, on a phone or a laptop. Nothing to install.",
    rows: [
      all("Live webinars in the browser", {
        hint: "Adaptive HD video, no download",
        detail: "Simulcast video that adapts to each viewer's network, with AV1 on capable devices.",
      }),
      all("Edge delivery for large audiences", {
        hint: "Low-latency streaming over a CDN",
        detail: "Big audiences watch a low-latency stream from a CDN near them, so the room stays smooth at hundreds.",
      }),
      all("Meetings with a lobby", {
        hint: "Instant or scheduled",
        detail: "Small-group calls from a link: guests knock, you admit them. Everyone can talk and share.",
      }),
      all("Simulive", {
        hint: "From an upload or a past recording",
        detail: "Play a recorded session at a set time as if it were live, with chat, polls and Q&A replayed.",
      }),
      all("Screen share, whiteboard and video share", {
        hint: "Play a file, a Drive video or a past recording",
        detail: "Sharp slides at up to 1080p, a shared whiteboard, and videos played into the session.",
      }),
      all("Cloud recording, replay and share links", {
        detail: "Every session recorded in the cloud, with captions, a replay page and reminders before it expires.",
      }),
      all("Local recording in the browser"),
      all("Live captions (English)", { detail: "Live English captions for the room and the recording." }),
      all("Co-hosts, panelists and host hand-over"),
      all("Backgrounds, blur and noise suppression", {
        detail: "Blur or a background, noise suppression and low-light correction, all in the browser.",
      }),
      all("Picture-in-picture"),
    ],
  },
  {
    id: "grow",
    title: "Grow your audience",
    intro: "Get people registered, reminded and back in the room.",
    rows: [
      all("Registration pages with custom questions", {
        detail: "A registration page per webinar with your own questions and a cover image.",
      }),
      all("Registration approval", { detail: "Approve registrants one by one or all at once." }),
      all("Email reminders and calendar invites", {
        detail: "Reminder emails with calendar invites, from templates you can edit.",
      }),
      all("Push notifications (installable app)", {
        detail: "Attendees install the web app and get a push when you go live and when the replay is ready.",
      }),
      all("Recurring and instant webinars"),
      all("Audience across all your webinars", {
        detail: "Everyone who registered or attended, across every webinar, in one list.",
      }),
      from("pro", "WhatsApp reminders and broadcasts", {
        hint: "Messages billed by Meta to your own account",
        detail: "Reminders, broadcasts and drips from your own WhatsApp Business number.",
      }),
      from("pro", "WhatsApp inbox, chatbot and drips", {
        detail: "Replies land in a shared inbox; a chatbot answers the common questions.",
      }),
    ],
  },
  {
    id: "engage",
    title: "Engage",
    intro: "Keep the room talking, and know who was really there.",
    rows: [
      all("Chat, Q&A, polls, quizzes and reactions", {
        detail: "Chat with images and @mentions, upvoted Q&A, polls, quizzes and emoji reactions.",
      }),
      all("Raised hands and bring to stage", { detail: "Attendees raise a hand; you bring them on stage." }),
      all("Offer pop-ups and post-session surveys", {
        detail: "Show an offer at the right moment and ask for feedback at the end.",
      }),
      all("Engagement Score for every attendee", {
        detail: "A 0-100 score per attendee from watch time, polls, quizzes, chat, Q&A and reactions.",
      }),
      all("Registrant, attendee and engagement CSV export", {
        detail: "Your data is yours: export registrants, attendance, engagement and transcripts.",
      }),
    ],
  },
  {
    id: "ai",
    title: "Automate with AI",
    intro: "AI that drafts, and you decide. Off until you turn it on; every use counts against your monthly AI credits.",
    rows: [
      ai("AI recap and insights", {
        detail: "A recap with chapters and action items, Q&A grouped by theme, and the hottest leads.",
      }),
      ai("AI answer drafts for Q&A", {
        hint: "Grounded in your knowledge base",
        detail: "Suggested answers to attendee questions, drawn from your own material, for you to post.",
      }),
      ai("AI knowledge base", {
        hint: "Documents, links or an Obsidian vault",
        detail: "Upload PDFs, Word or Markdown files, links or an Obsidian vault for the AI to answer from.",
      }),
      ai("Follow-up drafts by engagement", {
        detail: "Follow-up messages written for each engagement group, sent by email or WhatsApp.",
      }),
      ai("Simulive auto mode", {
        hint: "AI answers questions while a simulive plays",
        detail: "While a simulive plays, the AI answers questions it is confident about, from your knowledge base.",
      }),
      ai("Write with AI", { hint: "Titles, descriptions and registration copy" }),
      all("Chat spam filter", {
        hint: "Rules on every plan; the AI check uses credits",
        detail: "Spam and links caught in chat, with one-click clean-up.",
      }),
    ],
  },
  {
    id: "repurpose",
    title: "Repurpose content",
    intro: "Turn one session into a week of content.",
    rows: [
      from("pro", "Blog, newsletter and social drafts", {
        hint: "In your brand voice",
        detail: "A blog post, newsletter, LinkedIn, X or Instagram post from a session, in your brand voice.",
      }),
      from("pro", "AI highlights and reels", {
        detail: "The best moments found for you and cut as vertical, square or wide clips with captions.",
      }),
      from("pro", "Studio", {
        hint: "Recordings, clips and a content plan",
        detail: "Recordings, clips and a content plan of what to post and when, in one place.",
      }),
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    intro: "Work with the accounts you already have.",
    rows: [
      from("pro", "Stream to YouTube, LinkedIn, Facebook and Instagram", {
        detail: "Send the session live to YouTube, or to LinkedIn, Facebook or Instagram with a stream key.",
      }),
      from("pro", "Zoom", {
        hint: "Run a session on your own Zoom account",
        detail: "Schedule a session as a Zoom meeting or webinar; registrants get their own links, attendance comes back.",
      }),
      all("Google Drive", { detail: "Play a video from your Google Drive into a session." }),
      all("Google sign-in and calendar links"),
    ],
  },
  {
    id: "security",
    title: "Security & privacy",
    intro: "Your room, your rules, your data.",
    rows: [
      all("Encrypted in transit", { detail: "Live video travels encrypted (WebRTC), and pages and streams over HTTPS." }),
      all("Lobby, approval and host controls", {
        detail: "A lobby for meetings, approval for registrations, mute-all and remove for the stage.",
      }),
      all("Chat permissions", { detail: "Decide who can chat, and keep quiz answers hidden until voting ends." }),
      all("WhatsApp opt-in", { detail: "Attendees opt in before you can message them on WhatsApp." }),
      all("Recordings expire on schedule", {
        detail: "Recordings are deleted when their time is up, after two reminder emails.",
      }),
      all("Payments through Razorpay", { detail: "Card and UPI details go to Razorpay, never to us." }),
      all("Delete your account any time"),
    ],
  },
  {
    id: "support",
    title: "Support",
    rows: [
      all("Email support"),
      from("business", "Priority support on WhatsApp"),
      from("business", "Personal onboarding session"),
      from("enterprise", "Dedicated video server and a written agreement"),
    ],
  },
];

/** The groups the /features page shows: those with an intro. */
export function featureGroups(): CompareGroup[] {
  return COMPARISON.filter((g) => g.intro);
}

/** Which plans a feature is on, in words, for the /features page. */
export function availability(row: CompareRow): string {
  const c = row.cells;
  if (c.starter === ADD_ON_CELL) return "AI add-on on Starter, included from Pro";
  const first = PLAN_IDS.find((id) => c[id] !== false);
  if (!first) return "Not included";
  if (first === "starter") return "Every plan";
  if (first === "enterprise") return "Enterprise";
  return `${findPlan(first).name} and up`;
}

/** Where "see pricing" goes: the proposal page until the server charges these prices. */
export function pricingHref(status: PlansStatus = PLANS_STATUS): string {
  return status === "live" ? "/pricing" : "/pricing/proposed";
}

/** Proposal pages are kept out of search until they are the real price list. */
export function indexable(status: PlansStatus = PLANS_STATUS): boolean {
  return status === "live";
}

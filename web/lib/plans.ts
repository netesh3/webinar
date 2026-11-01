/* The plans, for the pages that show them without asking the server: the /features page, the
 * /features plan cards and the "Compare all features" table on /pricing and /features.
 *
 * (31 Oct 2026) The owner's lineup is live: Basic, Professional, Business and Enterprise.
 * Checkout still charges from the server's own table, api/internal/billing/billing.go
 * (Plans), and the /pricing cards read that through GET /api/billing/plans. This file
 * repeats what those pages need, and api/internal/billing/web_plans_test.go reads it back:
 * every price, list price, attendee and stage cap, card line and tier switch here must match
 * the server's, or the Go tests fail. The yearly rule and the list-price rule are the
 * server's too (billing.yearly, billing.YearlyList), and lib/plans.test.mts pins them.
 *
 * The grandfathered Starter (the first subscribers' ₹3,999 plan) is not here: it is never
 * shown to anyone new. The server keeps it for the accounts on it.
 *
 * Pure: no React, no DOM, so it runs under node tests (lib/plans.test.mts). */

export type PlansStatus = "proposal" | "live";
/** "live" since 31 Oct 2026: these are the plans checkout sells (the Go test above holds them). */
export const PLANS_STATUS: PlansStatus = "live";

export type Currency = "INR" | "USD";
export type Period = "monthly" | "yearly";
/** The page's plan ids. "pro" is the server's "professional" (Plan.server), shown as Professional. */
export type PlanId = "basic" | "pro" | "business" | "enterprise";

/** The server's plan id (types.Plan). */
export type ServerPlan = "basic" | "professional" | "business" | "enterprise";

export type PlanLimits = {
  /** Concurrent attendees in one webinar (types.PlanAttendeeCap). Enterprise's is where it starts. */
  attendees: number;
  /** People on a webinar stage at once, the host included (types.PlanStageCap). */
  stage: number;
  /** People in one meeting at once, the host included (types.PlanMeetingCap). */
  meetingCap: number;
  /** Storage, GB: cloud recordings, uploaded videos and clips together (plan_limits, migrations/0180). */
  recordingGb: number;
};

export type Plan = {
  id: PlanId;
  server: ServerPlan;
  name: string;
  who: string;
  /** Whole currency units a month, before GST. Null: contact us. */
  monthly: Record<Currency, number> | null;
  /** The monthly list price the real one is shown against, struck through (billing ListMonthly). */
  list?: Record<Currency, number>;
  popular?: boolean;
  /** Sold by talking to us: no price and no checkout. */
  contactOnly?: boolean;
  /** The card's bold first line (billing Plan.Lead): "Everything in Basic, plus:", or "Includes:". */
  lead: string;
  limits: PlanLimits;
  /** What the plan adds, after the limit lines: the server's Plan.Features, word for word. */
  highlights: string[];
};

/* The server's plans, in the same order. Each entry's server, monthly, list, lead, limits and
 * highlights are read by api/internal/billing/web_plans_test.go: keep the `key: value` shape.
 * (1 Nov 2026) Every paid plan's monthly price is 60% off its list. */
export const PLANS: Plan[] = [
  {
    id: "basic",
    server: "basic",
    name: "Basic",
    who: "For coaches running their first webinars",
    monthly: { INR: 2999, USD: 39 },
    list: { INR: 7499, USD: 99 },
    lead: "Includes:",
    limits: {
      attendees: 100,
      stage: 3,
      meetingCap: 10,
      recordingGb: 2,
    },
    highlights: [
      "Webinars with registration pages",
      "Email confirmations and reminders",
      "Engagement for every attendee",
      "Webinar Engagement Score",
    ],
  },
  {
    id: "pro",
    server: "professional",
    name: "Professional",
    who: "For coaches selling programs every week",
    monthly: { INR: 9999, USD: 149 },
    list: { INR: 24999, USD: 375 },
    popular: true,
    lead: "Everything in Basic, plus:",
    limits: {
      attendees: 300,
      stage: 5,
      meetingCap: 20,
      recordingGb: 10,
    },
    highlights: ["Cloud recording", "WhatsApp automations and campaigns", "WhatsApp follow-ups and scheduling"],
  },
  {
    id: "business",
    server: "business",
    name: "Business",
    who: "For academies and teams with big launches",
    monthly: { INR: 24999, USD: 349 },
    list: { INR: 62499, USD: 875 },
    lead: "Everything in Professional, plus:",
    limits: {
      attendees: 500,
      stage: 10,
      meetingCap: 100,
      recordingGb: 100,
    },
    highlights: [
      "Simulive: recordings played as live",
      "Server live captions",
      "AI recaps, knowledge base and follow-ups",
      "Chat spam filter",
      "Zoom and every advanced feature",
    ],
  },
  {
    id: "enterprise",
    server: "enterprise",
    name: "Enterprise",
    who: "For institutions and very large audiences",
    monthly: null,
    contactOnly: true,
    lead: "Everything in Business, plus:",
    limits: {
      attendees: 1000,
      stage: 100,
      meetingCap: 300,
      recordingGb: 500,
    },
    highlights: ["Customised for your organisation", "Priority support and onboarding"],
  },
];

/* What each plan includes of the server's switches (types.Features keys) that the plans differ
 * by: the server's store.TierFeatures, as migrations/0179 and 0180 set the tiers. Basic has none
 * of them: no cloud recording (the presenter records on their own computer), no WhatsApp and no
 * server captions (captions run on each speaker's device). Whiteboard and meetings are on every
 * plan and not listed. clips, instant_webinar and hls_delivery are on no plan (an admin's switch
 * for one host). The chat spam filter needs ai. Read by web_plans_test.go. */
export const TIER_FEATURES: Record<PlanId, string[]> = {
  basic: [],
  pro: ["cloud_recording", "whatsapp_crm"],
  business: [
    "cloud_recording",
    "whatsapp_crm",
    "simulive",
    "replay_engage",
    "zoom",
    "ai",
    "ai_knowledge",
    "simulive_auto",
    "followup_send",
    "repurpose",
    "captions",
  ],
  enterprise: [
    "cloud_recording",
    "whatsapp_crm",
    "simulive",
    "replay_engage",
    "zoom",
    "ai",
    "ai_knowledge",
    "simulive_auto",
    "followup_send",
    "repurpose",
    "captions",
  ],
};

/** Every switch TIER_FEATURES decides. */
export const TIERED_FEATURES: string[] = TIER_FEATURES.business;

/** Switches no plan includes: an admin turns one on for one host. Never shown as a plan's. */
export const PER_HOST_FEATURES = ["clips", "instant_webinar", "hls_delivery"];

export const TRIAL = {
  days: 7,
  /** The plan the trial's buttons point at; any monthly plan in INR can be trialled. */
  plan: "pro" as PlanId,
  /** The server only offers the trial in INR today (BillingCatalogue.trialCurrency). */
  currency: "INR" as Currency,
};

/** GST added to INR prices at checkout (BILLING_GST_PERCENT). */
export const GST_PERCENT = 18;

export function findPlan(id: PlanId): Plan {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown plan ${id}`);
  return p;
}

/** The page's plan for a server plan id, or undefined (the grandfathered Starter). */
export function planForServer(server: string): Plan | undefined {
  return PLANS.find((p) => p.server === server);
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

/* How yearly is presented (31 Oct 2026): YEARLY_OFF_PERCENT off a list price, not months free.
 * What a buyer pays is still yearlyPrice. The list is the charge over (1 − 80%), rounded: the
 * one place this rule lives on the page, the same as the server's billing.YearlyList. */
export const YEARLY_OFF_PERCENT = 80;

export function yearlyListPrice(charge: number): number {
  return Math.round((charge * 100) / (100 - YEARLY_OFF_PERCENT));
}

/** What one period costs, before GST, or null for a contact-only plan. */
export function priceFor(plan: Plan, currency: Currency, period: Period): number | null {
  if (!plan.monthly) return null;
  const m = plan.monthly[currency];
  return period === "yearly" ? yearlyPrice(m, currency) : m;
}

/** The struck-out list price for one period, or null when there is none: yearly always has one. */
export function listFor(plan: Plan, currency: Currency, period: Period): number | null {
  const price = priceFor(plan, currency, period);
  if (price === null) return null;
  if (period === "yearly") return yearlyListPrice(price);
  return plan.list?.[currency] ?? null;
}

/** How far below its list a price is, whole percent rounded down (billing.DiscountPercent). */
export function discountPercent(amount: number, list: number | null): number {
  if (!list || amount >= list) return 0;
  return Math.floor(((list - amount) * 100) / list);
}

/** The badge a discounted price carries: "60% OFF" (billing.OffLabel). */
export function offLabel(percent: number): string {
  return percent > 0 ? `${percent}% OFF` : "";
}

/** A whole-unit amount spread over a period's months: the yearly price over twelve. */
export function monthlyShare(amount: number, period: Period): number {
  return period === "yearly" ? Math.round(amount / 12) : amount;
}

/** The headline per-month figure: the yearly price spread over twelve months. */
export function perMonth(plan: Plan, currency: Currency, period: Period): number | null {
  const p = priceFor(plan, currency, period);
  return p === null ? null : monthlyShare(p, period);
}

/** The card's list after its lead, as the server's Plan.AllFeatures writes it: the limits, then
 *  what the plan adds. */
export function cardLines(plan: Plan): string[] {
  const n = (v: number) => v.toLocaleString("en-IN");
  const l = plan.limits;
  const attendees = plan.contactOnly ? `${n(l.attendees)}+ attendees` : `Up to ${n(l.attendees)} attendees`;
  return [
    attendees,
    `Up to ${n(l.stage)} people on stage`,
    `Meetings of up to ${n(l.meetingCap)} people`,
    `${n(l.recordingGb)} GB storage`,
    ...plan.highlights,
  ];
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

/* ------------------------------------------------------------------ comparison table */

/** A cell: included, not included, or a value to print. */
export type Cell = boolean | string;

export type CompareRow = {
  label: string;
  /** A short explanation: the table's tooltip under the label. */
  hint?: string;
  /** A sentence for the /features page; rows without one are table-only. */
  detail?: string;
  /** The server switch this row is (types.Features key): its cells are TIER_FEATURES, by test. */
  feature?: string;
  cells: Record<PlanId, Cell>;
};

export type CompareGroup = {
  id: string;
  title: string;
  /** The /features section's one-line intro; groups without one are table-only. */
  intro?: string;
  rows: CompareRow[];
};

export const PLAN_IDS: PlanId[] = ["basic", "pro", "business", "enterprise"];

function n(v: number): string {
  return v.toLocaleString("en-IN");
}

/** A limit row read from PLANS, so the table can never disagree with the cards. */
function limitRow(label: string, pick: (p: Plan) => Cell, hint?: string): CompareRow {
  const cells = {} as Record<PlanId, Cell>;
  for (const id of PLAN_IDS) cells[id] = pick(findPlan(id));
  return { label, hint, cells };
}

type RowText = { hint?: string; detail?: string };

/** Same on every plan. */
function all(label: string, text: RowText = {}): CompareRow {
  return {
    label,
    ...text,
    cells: { basic: true, pro: true, business: true, enterprise: true },
  };
}

/** A row that is a server switch: on exactly where TIER_FEATURES has it. */
function tier(feature: string, label: string, text: RowText = {}): CompareRow {
  const cells = {} as Record<PlanId, Cell>;
  for (const id of PLAN_IDS) cells[id] = TIER_FEATURES[id].includes(feature);
  return { label, ...text, feature, cells };
}

/** Only on Enterprise, as a value. */
function enterpriseOnly(label: string, value: Cell = true, text: RowText = {}): CompareRow {
  return {
    label,
    ...text,
    cells: { basic: false, pro: false, business: false, enterprise: value },
  };
}

/* "Compare all features": everything the product has today, checked in the code, against the
 * tiers of migrations/0179 and 0180. Not listed because they are not built: breakout rooms, SSO,
 * custom domains, branding beyond a cover image, a public API, webhooks or Zapier. Not listed
 * because no plan sells them: instant meetings and webinars, highlight clips and reels, and HLS
 * delivery (an admin's switch for one host). Not listed until the store listings are live: the
 * desktop and mobile apps. */
export const COMPARISON: CompareGroup[] = [
  {
    id: "capacity",
    title: "Capacity",
    rows: [
      limitRow(
        "Attendees per webinar",
        (p) => (p.contactOnly ? `${n(p.limits.attendees)}+` : n(p.limits.attendees)),
        "Watching live at once. The server holds every webinar to its plan's number.",
      ),
      limitRow(
        "People on stage",
        (p) => n(p.limits.stage),
        "Host, co-hosts, panelists and attendees brought on stage, together",
      ),
      limitRow("People per meeting", (p) => n(p.limits.meetingCap), "Everyone in a meeting is on camera, the host included"),
      limitRow(
        "Storage (uploads and recordings)",
        (p) => `${n(p.limits.recordingGb)} GB`,
        "Videos you upload to play in a session, cloud recordings and their captions, together",
      ),
    ],
  },
  {
    id: "live",
    title: "Webinars & meetings",
    intro: "Webinars, meetings and simulive in the browser, on a phone or a laptop. Nothing to install.",
    rows: [
      all("Live webinars in the browser", {
        hint: "Adaptive HD video, no download",
        detail: "Simulcast video that adapts to each viewer's network, with AV1 on capable devices.",
      }),
      all("Recurring webinars", {
        hint: "A series on a schedule, one registration",
        detail: "Run the same webinar every week or month as a series, each session with its own room.",
      }),
      all("Meetings with a lobby", {
        hint: "Scheduled, from a link",
        detail: "Small-group calls from a link: guests knock, you admit them. Everyone can talk and share.",
      }),
      tier("simulive", "Simulive", {
        hint: "A recording played as a live session",
        detail: "Play a recorded session at a set time as if it were live, with live chat and Q&A.",
      }),
      tier("replay_engage", "Simulive engagement replay", {
        hint: "The original chat, Q&A and polls, at the moment they happened",
        detail: "A simulive replays the original session's chat, Q&A and polls at the same point in the video.",
      }),
      all("Screen share, whiteboard and video share", {
        hint: "Play a file, a Drive video or a past recording",
        detail: "Sharp slides at up to 1080p, a shared whiteboard, and videos played into the session.",
      }),
      all("Co-hosts, panelists and host hand-over"),
      all("Backgrounds, blur and noise suppression", {
        detail: "Blur or a background, noise suppression and low-light correction, all in the browser.",
      }),
      all("Picture-in-picture"),
    ],
  },
  {
    id: "grow",
    title: "Registration & landing pages",
    intro: "Get people registered, and know who they are.",
    rows: [
      all("Registration pages with custom questions", {
        hint: "One page per webinar, with a cover image",
        detail: "A registration page per webinar with your own questions and a cover image.",
      }),
      all("Registration approval", { detail: "Approve registrants one by one or all at once." }),
      all("Calendar invites", { hint: "An .ics invite with every confirmation" }),
      all("Audience across all your webinars", {
        detail: "Everyone who registered or attended, across every webinar, in one list.",
      }),
    ],
  },
  {
    id: "reminders",
    title: "Reminders & follow-ups",
    intro: "Remind people before, follow up after, on email and WhatsApp.",
    rows: [
      all("Email confirmations and reminders", {
        hint: "Before the webinar, from templates you can edit",
        detail: "A confirmation when they register and reminder emails with calendar invites, at the times you choose.",
      }),
      tier("cloud_recording", "Replay email after the webinar", {
        hint: "The replay link to everyone who registered; needs a cloud recording",
        detail: "After the session, everyone who registered gets the replay by email.",
      }),
      all("Push notifications", {
        hint: "From the installable web app",
        detail: "Attendees install the web app and get a push when you go live and when the replay is ready.",
      }),
      tier("whatsapp_crm", "WhatsApp reminders and follow-ups", {
        hint: "From your own WhatsApp Business number; Meta bills its message fees to you",
        detail: "Reminders before and follow-ups after, from your own WhatsApp Business number.",
      }),
      tier("whatsapp_crm", "WhatsApp scheduling", {
        hint: "Messages timed to each webinar",
        detail: "Schedule each WhatsApp message against the webinar: a day before, an hour before, after it ends.",
      }),
      tier("whatsapp_crm", "WhatsApp campaigns", {
        hint: "Broadcasts to a tag or a segment",
        detail: "Broadcast to everyone, a tag or an engagement group, with Meta-approved templates.",
      }),
      tier("whatsapp_crm", "WhatsApp automations", {
        hint: "Drips, a chatbot and a shared inbox",
        detail: "Drips that run on their own, a chatbot for the common questions, and replies in one inbox.",
      }),
      tier("followup_send", "AI follow-up drafts by engagement", {
        hint: "Written per engagement group, sent by email or WhatsApp",
        detail: "Follow-up messages drafted for each engagement group, for you to review and send.",
      }),
    ],
  },
  {
    id: "engage",
    title: "Engagement",
    intro: "Keep the room talking, and know who was really there.",
    rows: [
      all("Chat, Q&A, polls and quizzes", {
        detail: "Chat with images and @mentions, upvoted Q&A, polls and quizzes.",
      }),
      all("Reactions and raised hands", { detail: "Emoji reactions, and raised hands you can bring on stage." }),
      all("Offer pop-ups and post-session surveys", {
        detail: "Show an offer at the right moment and ask for feedback at the end.",
      }),
      all("Engagement for every attendee", {
        hint: "Watch time, polls, chat, Q&A and reactions, per person",
        detail: "See what each attendee did: how long they watched, what they answered and asked.",
      }),
      all("Webinar Engagement Score", {
        hint: "0–100 per attendee",
        detail: "A 0-100 score per attendee from watch time, polls, quizzes, chat, Q&A and reactions.",
      }),
      tier("ai", "Chat spam filter", {
        hint: "Spam and links caught in chat and Q&A, by rules and an AI check, with one-click clean-up",
        detail: "Spam and links caught in chat and Q&A, with one-click clean-up.",
      }),
    ],
  },
  {
    id: "recording",
    title: "Recording & replay",
    intro: "Record every session, on your computer or in the cloud.",
    rows: [
      all("Local recording in the browser", {
        hint: "Saved on the presenter's computer",
        detail: "Record the session in the browser and keep the file on your own computer.",
      }),
      tier("cloud_recording", "Cloud recording", {
        hint: "Recorded on our servers, with captions; counts against your storage",
        detail: "Record to the cloud by hand or automatically, with captions in the recording.",
      }),
      tier("cloud_recording", "Replay pages and share links", {
        hint: "For cloud recordings",
        detail: "A replay page for every cloud recording, and links to share it.",
      }),
      tier("cloud_recording", "Recordings kept for 30 days", {
        hint: "Then Keep longer, 3 months at a time, within your storage",
        detail: "Cloud recordings are kept 30 days after the session, with reminders before they expire.",
      }),
    ],
  },
  {
    id: "streaming",
    title: "Streaming out",
    intro: "Go live on your channels at the same time.",
    rows: [
      all("Stream to YouTube", {
        detail: "Send the session live to your YouTube channel.",
      }),
      all("Stream to LinkedIn, Facebook and Instagram", {
        hint: "With the platform's stream key (RTMP)",
        detail: "Send the session live to LinkedIn, Facebook or Instagram with a stream key.",
      }),
    ],
  },
  {
    id: "ai",
    title: "AI & captions",
    intro: "AI that drafts, and you decide. On Business and Enterprise, within a monthly AI limit.",
    rows: [
      tier("ai", "AI recap and insights", {
        hint: "Chapters, action items, Q&A themes and hot leads",
        detail: "A recap with chapters and action items, Q&A grouped by theme, and the hottest leads.",
      }),
      tier("ai", "AI answer drafts for Q&A", {
        detail: "Suggested answers to attendee questions, for you to post.",
      }),
      tier("ai_knowledge", "AI knowledge base", {
        hint: "Documents, links or an Obsidian vault",
        detail: "Upload PDFs, Word or Markdown files, links or an Obsidian vault for the AI to answer from.",
      }),
      tier("simulive_auto", "Simulive auto mode", {
        hint: "The AI answers questions while a simulive plays",
        detail: "While a simulive plays, the AI answers the questions it is confident about, from your knowledge base.",
      }),
      tier("ai", "Write with AI", { hint: "Titles, descriptions and registration copy" }),
      tier("repurpose", "Blog, newsletter and social drafts", {
        hint: "From a session's transcript, in your brand voice",
        detail: "A blog post, newsletter, LinkedIn, X or Instagram post from a session, in your brand voice.",
      }),
      tier("captions", "Server live captions", {
        hint: "Made on our servers: English, Hindi, Hinglish, Tamil, Telugu, Kannada, Marathi, Bengali and Gujarati",
        detail: "Live captions made on our servers, in English and eight Indian languages, for the room and the recording.",
      }),
      all("Captions on the speaker's device", {
        hint: "Made in each speaker's browser, on every plan",
      }),
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    intro: "Work with the accounts you already have.",
    rows: [
      tier("zoom", "Zoom", {
        hint: "Run a session on your own Zoom account",
        detail:
          "Schedule a session as a Zoom meeting or webinar; registrants get their own links, attendance comes back.",
      }),
      all("Google Drive", {
        detail: "Play a video from your Google Drive into a session.",
      }),
      all("Google sign-in and calendar links"),
    ],
  },
  {
    id: "analytics",
    title: "Analytics & exports",
    rows: [
      all("Attendance by device", {
        hint: "Phone, laptop or tablet, and the browser",
      }),
      all("Attendance by location", { hint: "Country and city" }),
      all("CSV exports", {
        hint: "Registrants, attendance, engagement and transcripts",
        detail: "Your data is yours: export registrants, attendance, engagement and transcripts.",
      }),
    ],
  },
  {
    id: "branding",
    title: "Branding & customisation",
    rows: [
      all("Cover image on every page", {
        hint: "Registration, waiting room and replay",
      }),
      enterpriseOnly("Customised for your organisation", true, {
        hint: "Set up with our team",
      }),
    ],
  },
  {
    id: "security",
    title: "Support & security",
    intro: "Your room, your rules, your data.",
    rows: [
      all("Email support"),
      all("GST invoice", { hint: "Add your GSTIN at checkout" }),
      enterpriseOnly("Priority support and onboarding"),
      all("Encrypted in transit", {
        detail: "Live video travels encrypted (WebRTC), and pages and streams over HTTPS.",
      }),
      all("Lobby, approval and host controls", {
        detail: "A lobby for meetings, approval for registrations, mute-all and remove for the stage.",
      }),
      tier("whatsapp_crm", "WhatsApp opt-in", {
        detail: "Attendees opt in before you can message them on WhatsApp.",
      }),
      all("Payments through Razorpay", {
        detail: "Card and UPI details go to Razorpay, never to us.",
      }),
      all("Delete your account any time"),
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
  const first = PLAN_IDS.find((id) => c[id] !== false);
  if (!first) return "Not included";
  if (first === "basic") return "Every plan";
  if (first === "enterprise") return "Enterprise";
  return `${findPlan(first).name} and up`;
}

/** Where "see pricing" goes. */
export function pricingHref(status: PlansStatus = PLANS_STATUS): string {
  return status === "live" ? "/pricing" : "/pricing/proposed";
}

/** Proposal pages are kept out of search until they are the real price list. */
export function indexable(status: PlansStatus = PLANS_STATUS): boolean {
  return status === "live";
}

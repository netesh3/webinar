import type {
  Account,
  JoinResponse,
  LiveRoom,
  RegistrantRow,
  SessionControls,
  Webinar,
} from "@/lib/api-types";
import type { ChatMessage, Question, Realtime, Sender } from "@/lib/realtime";
import type { NetworkHealth } from "@/lib/network";
import { ConnectionQuality } from "livekit-client";
import { isDevAuthBypass } from "@/lib/dev-bypass-flag";

export { isDevAuthBypass };

/* Local UI-preview fixtures + session mock.
 *
 * Env flag: lib/dev-bypass-flag.ts (Edge-safe for middleware).
 * Tab opt-out: lib/dev-bypass-session.ts (sessionStorage + cookie mirror).
 */

export const DEV_BYPASS_ACCOUNT: Account = {
  id: "dev-bypass-host",
  email: "preview@localhost.dev",
  name: "Preview Host",
  title: "Product",
  org: "Local Preview",
  phone: "",
  initials: "PH",
  hue: "#3B6EA5",
  canHost: true,
  isAdmin: true,
};

const CONTROLS: SessionControls = {
  hideAttendees: false,
  muteOnEntry: true,
  allowUnmute: true,
  chatEnabled: true,
  qaEnabled: true,
  raiseHandEnabled: true,
  reactionsEnabled: true,
  pollsEnabled: true,
  locked: false,
  chatDestination: "everyone",
};

const HOST_PERSON = {
  id: DEV_BYPASS_ACCOUNT.id,
  name: DEV_BYPASS_ACCOUNT.name,
  title: DEV_BYPASS_ACCOUNT.title,
  org: DEV_BYPASS_ACCOUNT.org,
  initials: DEV_BYPASS_ACCOUNT.initials,
  hue: DEV_BYPASS_ACCOUNT.hue,
};

function daysFromNow(days: number, hour = 15): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Fixture webinars for the host portal preview. */
export const DEV_BYPASS_WEBINARS: Webinar[] = [
  {
    id: "preview",
    webinarId: "100-200-300",
    topic: "Product walkthrough — UI preview",
    summary: "A fixture session so you can review host and room chrome without signing in.",
    description: "Local preview data only. Not backed by LiveKit or the API.",
    track: "Product",
    startsAt: daysFromNow(0, 14),
    durationMin: 60,
    timeZone: "Asia/Kolkata",
    kind: "webinar",
    status: "scheduled",
    host: HOST_PERSON,
    panelists: [],
    agenda: [{ at: "0:00", title: "Welcome" }],
    takeaways: ["See the redesigned host portal", "Open the room chrome preview"],
    registrationRequired: true,
    approval: "manual",
    guestJoinAllowed: false,
    attendeeLimit: 500,
    registrantCount: 42,
    customQuestions: [],
    options: {
      practiceSession: false,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
    },
    controls: CONTROLS,
    passcode: "2468",
    passcodeRequired: true,
  },
  {
    id: "preview-live",
    webinarId: "100-200-301",
    topic: "Customer Q&A (live fixture)",
    summary: "Looks live so you can check Rejoin / End controls.",
    description: "",
    track: "Support",
    startsAt: daysFromNow(0, 10),
    durationMin: 45,
    timeZone: "Asia/Kolkata",
    kind: "webinar",
    status: "live",
    startedAt: daysFromNow(0, 10),
    host: HOST_PERSON,
    panelists: [],
    agenda: [],
    takeaways: [],
    registrationRequired: true,
    approval: "automatic",
    guestJoinAllowed: true,
    attendeeLimit: 200,
    registrantCount: 87,
    customQuestions: [],
    options: {
      practiceSession: false,
      autoRecord: true,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
    },
    controls: CONTROLS,
    passcodeRequired: false,
  },
  {
    id: "preview-draft",
    webinarId: "100-200-302",
    topic: "Untitled draft — finish setup",
    summary: "",
    description: "",
    track: "",
    startsAt: daysFromNow(7, 16),
    durationMin: 30,
    timeZone: "Asia/Kolkata",
    kind: "webinar",
    status: "draft",
    host: HOST_PERSON,
    panelists: [],
    agenda: [],
    takeaways: [],
    registrationRequired: true,
    approval: "automatic",
    guestJoinAllowed: true,
    attendeeLimit: 100,
    registrantCount: 0,
    customQuestions: [],
    options: {
      practiceSession: false,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
    },
    controls: CONTROLS,
    passcodeRequired: false,
  },
  {
    id: "preview-past",
    webinarId: "100-200-303",
    topic: "Launch webinar — attendance report",
    summary: "Ended fixture with attendance numbers.",
    description: "",
    track: "Launch",
    startsAt: daysFromNow(-14, 15),
    durationMin: 60,
    timeZone: "Asia/Kolkata",
    kind: "webinar",
    status: "ended",
    startedAt: daysFromNow(-14, 15),
    endedAt: daysFromNow(-14, 16),
    host: HOST_PERSON,
    panelists: [],
    agenda: [],
    takeaways: [],
    registrationRequired: true,
    approval: "automatic",
    guestJoinAllowed: true,
    attendeeLimit: 500,
    registrantCount: 312,
    customQuestions: [],
    options: {
      practiceSession: false,
      autoRecord: true,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: true,
    },
    controls: CONTROLS,
    passcodeRequired: false,
    report: { attended: 248, avgWatchMin: 41, questions: 18 },
  },
];

export const DEV_BYPASS_REGISTRANTS: RegistrantRow[] = [
  {
    id: "reg-1",
    name: "Asha Mehta",
    email: "asha@example.com",
    company: "Northwind",
    jobTitle: "PM",
    state: "pending",
    createdAt: daysFromNow(-1),
    hasAccount: true,
  },
  {
    id: "reg-2",
    name: "Jordan Lee",
    email: "jordan@example.com",
    company: "Contoso",
    jobTitle: "Engineer",
    state: "pending",
    createdAt: daysFromNow(-1),
    hasAccount: false,
  },
  {
    id: "reg-3",
    name: "Sam Ortiz",
    email: "sam@example.com",
    company: "Fabrikam",
    state: "approved",
    createdAt: daysFromNow(-3),
    hasAccount: true,
  },
  {
    id: "reg-4",
    name: "Guest visitor",
    email: "",
    state: "approved",
    createdAt: daysFromNow(-2),
    hasAccount: false,
    isGuest: true,
  },
];

export function bypassWebinar(slug: string): Webinar | undefined {
  return DEV_BYPASS_WEBINARS.find((w) => w.id === slug) ?? DEV_BYPASS_WEBINARS[0];
}

export const DEV_BYPASS_ME: Sender = {
  identity: "host-preview",
  name: DEV_BYPASS_ACCOUNT.name,
  role: "host",
};

export const DEV_BYPASS_JOIN: JoinResponse = {
  token: "preview-token",
  url: "wss://preview.invalid",
  room: "preview-room",
  role: "host",
  identity: DEV_BYPASS_ME.identity,
  displayName: DEV_BYPASS_ME.name,
  canPublish: true,
  controls: CONTROLS,
  topic: DEV_BYPASS_WEBINARS[0].topic,
  startedAt: new Date().toISOString(),
  hidden: false,
  canRecord: true,
};

function livePerson(
  identity: string,
  name: string,
  role: "host" | "panelist" | "attendee",
  extra: Partial<LiveRoom["participants"][number]> = {},
): LiveRoom["participants"][number] {
  const onStage = role !== "attendee";
  return {
    identity,
    name,
    role,
    joinedAt: new Date().toISOString(),
    publishing: onStage ? ["VIDEO/CAMERA"] : [],
    audioMuted: role !== "host",
    hidden: false,
    canPublish: onStage,
    canSpeak: onStage,
    audioOnly: false,
    mutedByHost: false,
    coHost: false,
    ...extra,
  };
}

export const DEV_BYPASS_LIVE: LiveRoom = {
  room: "preview-room",
  status: "live",
  controls: CONTROLS,
  attendees: 2,
  onStage: 5,
  participants: [
    livePerson(DEV_BYPASS_ME.identity, DEV_BYPASS_ME.name, "host", {
      publishing: ["VIDEO/CAMERA", "AUDIO/MICROPHONE"],
      audioMuted: false,
    }),
    livePerson("panel-1", "Alex Chen", "panelist"),
    livePerson("panel-2", "Sam Ortiz", "panelist"),
    livePerson("panel-3", "Asha Mehta", "panelist"),
    livePerson("panel-4", "Jordan Lee", "panelist"),
    livePerson("att-1", "Priya Shah", "attendee"),
    livePerson("att-2", "Guest visitor", "attendee"),
  ],
};

const noopAsync = async () => undefined;

export function bypassRealtime(): Realtime {
  const chat: ChatMessage[] = [
    {
      kind: "chat",
      id: "c1",
      from: { identity: "att-1", name: "Priya Shah", role: "attendee" },
      destination: "everyone",
      text: "Looking forward to the walkthrough!",
      at: Date.now() - 120_000,
      seq: 1,
    },
    {
      kind: "chat",
      id: "c2",
      from: DEV_BYPASS_ME,
      destination: "everyone",
      text: "We'll start with the host portal, then the room side panel.",
      at: Date.now() - 60_000,
      seq: 2,
    },
  ];
  const questions: Question[] = [
    {
      kind: "question",
      id: "q1",
      from: { identity: "att-1", name: "Priya Shah", role: "attendee" },
      text: "Will recordings be available afterward?",
      anonymous: false,
      at: Date.now() - 90_000,
      votes: 4,
      answered: false,
      votedByMe: false,
    },
  ];

  return {
    chat,
    questions,
    hands: [{ identity: "att-1", name: "Priya Shah", at: Date.now() - 30_000 }],
    reactions: [],
    myHandRaised: false,
    sendChat: async () => ({ delivered: true }),
    askQuestion: noopAsync,
    upvote: noopAsync,
    markAnswered: noopAsync,
    toggleHand: noopAsync,
    lowerHand: noopAsync,
    clearHands: noopAsync,
    pollsRevision: 0,
    mergeBacklog: () => undefined,
    chatCursor: 2,
    react: noopAsync,
    askToUnmute: noopAsync,
  };
}

export const DEV_BYPASS_NETWORK: NetworkHealth = {
  quality: ConnectionQuality.Excellent,
  lossPercent: 0,
  rttMs: 42,
  rttFloorMs: 38,
  jitterMs: 2,
  playoutMs: 40,
  availableOutgoingKbps: 2500,
  tier: "full",
  degraded: false,
};

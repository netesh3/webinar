import type {
  AdminSFUBox,
  BrandVoice,
  RepurposeEditRequest,
  RepurposeRequest,
  RepurposeResponse,
  VideoServerStatus,
  FollowupPlanRequest,
  FollowupPlanResponse,
  FollowupSendItem,
  FollowupSendRequest,
  FollowupSendResponse,
  LobbyAdmitAllResponse,
  LobbyEntry,
  MeetingKnockRequest,
  MeetingKnockResponse,
  SaveStreamKeyRequest,
  SetWebinarStreamPausedRequest,
  WebinarStreamDestination,
  AIStatus,
  AIWebinarSetup,
  AIWebinarSetupRequest,
  QAClustersResponse,
  SpamFlagsResponse,
  SpamSettings,
  SpamSettingsPatch,
  QASuggestResponse,
  QAPostDraftResponse,
  KnowledgeDoc,
  KnowledgeDocDetail,
  KnowledgeLibrary,
  KnowledgeVaultImport,
  PastAnswerResult,
  PastAnswers,
  SessionKnowledge,
  SalesChat,
  SalesConversationDetail,
  SalesInbox,
  ChatMessage as ChatTranscriptMessage,
  Account,
  AttendingPage,
  AccountKind,
  AdminAccountCounts,
  SetAccountKindRequest,
  DeleteAccountRequest,
  Plan,
  PlanFeatures,
  PlanFeaturesBody,
  SetUserMediaQuotaRequest,
  SetUserMeetingCapRequest,
  SetUserStageCapRequest,
  SetUserPlanRequest,
  WebinarImageFromMediaRequest,
  SetUserSFURequest,
  SFUProjectsResponse,
  WhatsAppConsent,
  AdminStats,
  AdminUser,
  AdminWhatsAppUsage,
  AdminCostsResponse,
  AdminCostHostDetail,
  CostIgnoreList,
  CostIgnoreRule,
  CostIgnoreRuleInput,
  AlertsChangedResponse,
  AlertsResponse,
  AppConfig,
  ApprovalsResponse,
  BillingCatalogue,
  BillingCheckout,
  BillingStatus,
  StartTrialRequest,
  TrialCheckout,
  VerifyTrialRequest,
  VerifyTrialResponse,
  CreateBillingOrderRequest,
  VerifyBillingPaymentRequest,
  VerifyBillingPaymentResponse,
  ChatBacklog,
  RoomQuestions,
  ChatImageResponse,
  ChatStats,
  CoHostPatch,
  ControlsPatch,
  ServerCaptionsRequest,
  EngagementAttendeeDetail,
  EngagementAttendeePage,
  EngagementSummary,
  FeatureGrant,
  FeatureGrants,
  HostWebinarPage,
  JoinResponse,
  RejoinCheckResponse,
  LiveRoom,
  MuteAllResponse,
  Person,
  ProfilePatch,
  PublicRecording,
  RegisteredWebinar,
  RegisterRequest,
  Registration,
  Recording,
  Poll,
  PollInput,
  PollVoteRequest,
  QuestionPatch,
  RegistrantPage,
  RegistrantRow,
  RegistrationState,
  Role,
  SendMessageRequest,
  SendMessageResponse,
  SessionReport,
  SessionRecapResponse,
  LeadsResponse,
  FollowupsResponse,
  FollowupDraft,
  SignupResponse,
  ShareRecordingRequest,
  StageAllResponse,
  StatusResponse,
  PresenceRequest,
  PresenceResponse,
  SetStreamRequest,
  AudienceSurvey,
  HostSurvey,
  Survey,
  SurveyClickRequest,
  SurveyInput,
  SurveyResults,
  SurveySubmitRequest,
  SurveyTextPage,
  IntegrationsResponse,
  Webinar,
  WebinarInput,
  EdgeStatus,
  DeliveryPolicy,
  ServerTime,
  ReplayHideRequest,
  SimuliveAutoAnswer,
  SimuliveAutoAnswerRequest,
  QAAutoRequest,
  QAAutoResponse,
  ReplayHideResponse,
  ReplayPage,
  SimuliveScheduleRequest,
  SimuliveStartRequest,
  ReplayTimeline,
  RecordingStorage,
  StartVideoUploadRequest,
  VideoUpload,
  VideoUploadPartsResponse,
  KeepRecordingLinkRequest,
  KeepRecordingLinkResponse,
  SetUserRecordingStorageRequest,
} from "./api-types";
import { toSearchParams, type AttendeeQuery } from "./engagement/query";
import { captionsURL } from "./caption-track";
import { attendeesCsvPath, type AttendeeScope } from "./attendee-export";

/* Typed fetch client for the Go API.
 *
 * Types come from api-types.ts, which tygo generates from the Go structs — so
 * this file cannot describe a shape the backend doesn't actually send. */

/* Where the API is — two answers, because there are two kinds of caller.
 *
 * The browser reaches it through the origin it loaded the page from, so in a
 * single-origin deployment (a reverse proxy sending /api to the API and everything
 * else to Next) this is the empty string and every request is relative. That is
 * what keeps the domain out of the bundle: NEXT_PUBLIC_ values are inlined at
 * build time, so one image works for any hostname.
 *
 * A Server Component has no origin. fetch() in Node needs an absolute URL, so the
 * server talks to the API directly over the internal network — which also skips a
 * pointless hop back out through the proxy. Without this the root layout's config
 * fetch fails at render time with "Failed to parse URL".
 */
import {
  dropHostWebinarLists,
  HOST_LIST_PICKER_KEY,
  HOST_LIST_PREFIX,
  HOST_WEBINAR_PAGE_SIZE,
  hostListFilterKey,
  hostListPageKey,
  type HostListKind,
} from "./host-list-cache";
import {
  API_BASE,
  ApiError,
  baseFor,
  cachedGet,
  del,
  dropCache,
  fresh,
  patch,
  post,
  put,
  readCache,
  request,
  seg,
  TTL_CONFIG,
  TTL_LIST,
  TTL_SESSION,
  writeCache,
} from "./http";

const ME_KEY = "/api/auth/me";
const INTEGRATIONS_KEY = "/api/host/integrations";
const REGISTRATIONS_KEY = "/api/me/registrations";
const TRACKS_KEY = "/api/host/tracks";

export { API_BASE, ApiError };

/* Which bucket of the host's own list to read — the three tabs the host portal
 * shows, and the `tab` parameter the API takes, which are deliberately the same
 * three words so a tab click needs no translation.
 *
 * Spelled out here rather than taken from api-types.ts because tygo renders a
 * Go string type as `string`, which would accept "upcomming" silently. Same
 * reason adminWebinars inlines its own status union. */
export type HostWebinarTab = "upcoming" | "past" | "drafts";

type HostWebinarQuery = {
  tab?: HostWebinarTab;
  /** Webinars only (no meetings) or meetings only; absent is both. */
  kind?: HostListKind;
  q?: string;
  from?: string;
  to?: string;
  /** Completed only: sessions with, or without, a playable recording. */
  recording?: "with" | "without";
  limit?: number;
  cursor?: string;
};

/** Where one host-list read is kept.
 *
 *  The first page at the portal's page size uses the same key the screen paints
 *  from, so a request started beside the login check is the page the screen
 *  shows — not a second round trip. Other limits and later pages keep their own
 *  key under the same prefix, which is what a create or delete drops. */
function hostWebinarsKey(params: HostWebinarQuery): string {
  const tab = params.tab ?? "upcoming";
  const filter = hostListFilterKey(
    tab,
    params.q ?? "",
    params.from ?? "",
    params.to ?? "",
    params.kind ?? "",
    params.recording ?? "",
  );
  const limit = params.limit ?? HOST_WEBINAR_PAGE_SIZE;
  if (!params.cursor && limit === HOST_WEBINAR_PAGE_SIZE) {
    return hostListPageKey(filter, 0);
  }
  const qs = new URLSearchParams();
  qs.set("tab", tab);
  if (params.kind) qs.set("kind", params.kind);
  if (params.q) qs.set("q", params.q);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.recording) qs.set("recording", params.recording);
  qs.set("limit", String(limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  return `${HOST_LIST_PREFIX}${qs.toString()}`;
}

// The cost report's query: empty parts are left out (an empty range is all time).
function costQuery(q: { from?: string; to?: string; provider?: string; fresh?: boolean }): string {
  const qs = new URLSearchParams();
  if (q.from) qs.set("from", q.from);
  if (q.to) qs.set("to", q.to);
  if (q.provider) qs.set("provider", q.provider);
  if (q.fresh) qs.set("fresh", "1");
  return qs.toString();
}

function hostWebinarsPath(params: HostWebinarQuery): string {
  const qs = new URLSearchParams();
  if (params.tab) qs.set("tab", params.tab);
  if (params.kind) qs.set("kind", params.kind);
  if (params.q) qs.set("q", params.q);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.recording) qs.set("recording", params.recording);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const s = qs.toString();
  return `/api/host/webinars${s ? `?${s}` : ""}`;
}

export type AttendingQuery = {
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

function attendingPath(params: AttendingQuery): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const s = qs.toString();
  return `/api/me/attending${s ? `?${s}` : ""}`;
}

// ------------------------------------------------------------------- public

/* The home page's sales chat, visitor side. The visitor has no account: the chat's
 * own token (returned by start) goes in X-Chat-Token on every later call. */
function salesCall<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  after: number,
  body?: unknown,
) {
  return request<T>(`${path}?after=${after}`, {
    method,
    cache: "no-store",
    headers: {
      "X-Chat-Token": token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export const salesChat = {
  start: (page: string) => post<SalesChat>("/api/sales/chat", { page }),
  poll: (token: string, after: number) =>
    salesCall<SalesChat>("GET", "/api/sales/chat", token, after),
  say: (token: string, after: number, body: string) =>
    salesCall<SalesChat>("POST", "/api/sales/chat/messages", token, after, {
      body,
    }),
  handoff: (token: string, after: number) =>
    salesCall<SalesChat>("POST", "/api/sales/chat/handoff", token, after, {}),
  contact: (token: string, after: number, email: string, name?: string) =>
    salesCall<SalesChat>("POST", "/api/sales/chat/contact", token, after, {
      email,
      name,
    }),
};

export const api = {
  /** Branding, public URLs and limits an operator sets. Read once at boot so no
   *  such value is baked into the bundle. */
  config: () => cachedGet<AppConfig>("/api/config", { ttl: TTL_CONFIG }),

  /** What THIS account may see: hosted, presenting, or registered. Requires a
   *  session — an anonymous caller gets 401, not an empty list, because "nothing
   *  for you" and "who are you" need different screens. */
  listWebinars: () => request<Webinar[]>("/api/webinars", fresh),

  /** One webinar by slug, and deliberately still public: a registration link has
   *  to work for somebody who has no account yet. */
  getWebinar: (slug: string) =>
    request<Webinar>(`/api/webinars/${seg(slug)}`, fresh),

  /** For a signed-in person about to register: the phone to prefill, and whether
   *  this webinar's coach may already message them on WhatsApp. */
  whatsappConsent: (slug: string) =>
    request<WhatsAppConsent>(
      `/api/webinars/${seg(slug)}/whatsapp-consent`,
      fresh,
    ),

  register: async (slug: string, body: RegisterRequest) => {
    const reg = await post<Registration>(
      `/api/webinars/${seg(slug)}/register`,
      body,
    );
    dropCache(REGISTRATIONS_KEY);
    return reg;
  },

  /** Resolves locally-held join keys back into registrations, WITH the webinar
   *  attached. The webinar used to be looked up from the public catalogue; there
   *  is no public catalogue any more, so the answer has to be self-contained or a
   *  guest who registered without an account could never see what they signed up
   *  for. */
  lookup: (joinKeys: string[]) =>
    post<RegisteredWebinar[]>("/api/registrations/lookup", { joinKeys }),

  /** The name-only door: creates a registration and returns a token in one call.
   *
   *  Refused with 403 `registration_required` when the host's account does not
   *  allow joining without registering, or this webinar still requires it — the
   *  landing page should show Register. Also 409 `guest_join_disabled` when the
   *  host approves each attendee, and 403 `passcode_required` when there is a
   *  passcode. The landing page already knows from `webinar.guestJoinAllowed`,
   *  so reaching any of these means the webinar changed while the page was open.
   *  The response carries `joinKey`, which is the only thing that gets a guest
   *  back in after a reload. */
  guestJoin: (slug: string, name: string) =>
    post<JoinResponse>(`/api/webinars/${seg(slug)}/guest-join`, { name }),

  /** A meeting's front door: a name, and a place in the lobby. A browser that knocked
   *  already sends its key back and is told where it stands (waiting or admitted) instead
   *  of queueing twice. 403 `lobby_denied` when the host turned this key away; 409
   *  `meeting_ended`, `locked` or `lobby_full`. The waiting page then polls `join` with
   *  the key — lib/meeting-lobby.ts is what each answer means on screen. */
  meetingKnock: (slug: string, body: MeetingKnockRequest) =>
    post<MeetingKnockResponse>(
      `/api/webinars/${seg(slug)}/meeting/knock`,
      body,
    ),

  /** Exchanges a join key — or the session cookie — for a LiveKit token. The
   *  server decides the role; a client cannot ask for one. */
  join: (slug: string, joinKey?: string, opts?: { rejoin?: boolean }) =>
    post<JoinResponse>(
      `/api/webinars/${seg(slug)}/join${opts?.rejoin ? "?rejoin=1" : ""}`,
      joinKey ? { joinKey } : {},
    ),

  /** Whether a browser that was in the room a few minutes ago should go straight back in
   *  (lib/rejoin.ts). Uses the same credentials as join — the key, the session, or the
   *  httpOnly rejoin cookie — and never errors for a no. */
  rejoinCheck: (slug: string, joinKey?: string) =>
    post<RejoinCheckResponse>(
      `/api/webinars/${seg(slug)}/rejoin-check`,
      joinKey ? { joinKey } : {},
    ),

  /** The Leave button: forget the rejoin cookie, so reopening the link does not put this
   *  browser back in the room. */
  leaveRoom: (slug: string) =>
    post<StatusResponse>(`/api/webinars/${seg(slug)}/leave`),

  /** Hands one realtime message to the server for delivery.
   *
   *  This is how the AUDIENCE chats, asks and reacts: their tokens carry
   *  canPublishData=false, so the SFU refuses a packet they publish themselves. The
   *  server stamps the sender and — for chat — picks the recipients from the host's
   *  destination setting, which is what makes that setting enforceable rather than
   *  a request the sending browser is trusted to honour. */
  say: (slug: string, body: SendMessageRequest) =>
    post<SendMessageResponse>(`/api/webinars/${seg(slug)}/say`, body),

  /** Polls, as the AUDIENCE is allowed to see them: no drafts, a tally only where
   *  the host shared it, and the answer to a quiz only once voting has closed. The
   *  narrowing is the server's, not a filter here. */
  polls: (slug: string, joinKey?: string) =>
    request<Poll[]>(
      `/api/webinars/${seg(slug)}/polls${joinKey ? `?joinKey=${seg(joinKey)}` : ""}`,
      fresh,
    ),

  vote: (slug: string, id: string, body: PollVoteRequest) =>
    post<Poll>(`/api/webinars/${seg(slug)}/polls/${seg(id)}/vote`, body),

  /** The post-event survey as this attendee may see it, with their own response. */
  audienceSurvey: (slug: string, joinKey?: string, signal?: AbortSignal) =>
    request<AudienceSurvey>(
      `/api/webinars/${seg(slug)}/survey${joinKey ? `?joinKey=${seg(joinKey)}` : ""}`,
      { ...fresh, signal },
    ),

  submitSurvey: (slug: string, body: SurveySubmitRequest) =>
    post<AudienceSurvey>(`/api/webinars/${seg(slug)}/survey/responses`, body),

  surveyClick: (slug: string, body: SurveyClickRequest) =>
    post<StatusResponse>(`/api/webinars/${seg(slug)}/survey/click`, body),

  /** What this participant has not seen.
   *
   *  `since` is the highest sequence they hold — zero on a fresh join, which returns
   *  the conversation so far. The same request either way: "catch up after a dropped
   *  connection" and "read what was said before I arrived" are one question with a
   *  different cursor. The backlog is filtered by the same audience rule live delivery
   *  used, so replaying it cannot hand somebody the panelists-only lines the SFU
   *  refused them. */
  chatBacklog: (slug: string, since: number, joinKey?: string) =>
    request<ChatBacklog>(
      `/api/webinars/${seg(slug)}/chat?since=${since}` +
        (joinKey ? `&joinKey=${seg(joinKey)}` : ""),
      fresh,
    ),

  /** The room's Q&A as this participant may see it, with their own upvotes — what a
   *  rejoin or a reconnect reads back. Hidden questions come back to the audience as
   *  ids only. */
  /** Edge delivery: the event stream URL an edge viewer opens with EventSource (the
   *  token is a query parameter because EventSource cannot send headers). */
  edgeEventsUrl: (slug: string, token: string) =>
    `${API_BASE}/api/webinars/${seg(slug)}/events?t=${encodeURIComponent(token)}`,
  /** The edge viewer's attendance (lib/edge-events.ts): a beat while watching, a goodbye on leaving. */
  edgeBeatUrl: (slug: string, token: string) =>
    `${API_BASE}/api/webinars/${seg(slug)}/events/beat?t=${encodeURIComponent(token)}`,
  edgeLeaveUrl: (slug: string, token: string) =>
    `${API_BASE}/api/webinars/${seg(slug)}/events/leave?t=${encodeURIComponent(token)}`,

  /** Which delivery the schedule form offers, for a new webinar or one being edited
   *  (lib/delivery-policy.ts). */
  hostDeliveryPolicy: (slug?: string) =>
    request<DeliveryPolicy>(
      `/api/host/delivery${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`,
      fresh,
    ),

  /** The host's view of edge delivery for one webinar: on or off, and how many watch. */
  hostEdgeStatus: (slug: string) =>
    request<EdgeStatus>(`/api/host/webinars/${seg(slug)}/edge`, fresh),

  /** The server's clock, for the edge latency overlay. */
  serverTime: () => request<ServerTime>("/api/time", fresh),

  roomQuestions: (slug: string, joinKey?: string) =>
    request<RoomQuestions>(
      `/api/webinars/${seg(slug)}/questions${joinKey ? `?joinKey=${seg(joinKey)}` : ""}`,
      fresh,
    ),

  /** A simulive's engagement replay: the original session's chat, Q&A and polls at their
   *  offsets into the video, privacy-shortened. `enabled` false for a session without it.
   *  See lib/simulive-replay.ts for how the room schedules it. */
  replayTimeline: (slug: string, joinKey?: string) =>
    request<ReplayTimeline>(
      `/api/webinars/${seg(slug)}/replay${joinKey ? `?joinKey=${seg(joinKey)}` : ""}`,
    ),

  /** The host's preview of the replay: every item with its key and whether it is hidden. */
  hostReplayPreview: (
    slug: string,
    q: { filter?: string; q?: string; at?: number; cursor?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.filter && q.filter !== "all") params.set("filter", q.filter);
    if (q.q?.trim()) params.set("q", q.q.trim());
    if (q.at != null && q.at >= 0) params.set("at", String(Math.round(q.at)));
    if (q.cursor) params.set("cursor", q.cursor);
    if (q.limit) params.set("limit", String(q.limit));
    const qs = params.toString();
    return request<ReplayPage>(`/api/host/webinars/${seg(slug)}/replay${qs ? `?${qs}` : ""}`, fresh);
  },

  /** Hides items of the replay from the audience, or shows them again: one key, a page of
   *  keys, or (all) everything in a filter and search. */
  setReplayHidden: (slug: string, req: ReplayHideRequest) =>
    put<ReplayHideResponse>(`/api/host/webinars/${seg(slug)}/replay/hidden`, req),

  /** How a scheduled simulive starts: by itself or by the host, and when its doors open. */
  setSimuliveStart: (slug: string, req: SimuliveStartRequest) =>
    put<Webinar>(`/api/host/webinars/${seg(slug)}/simulive-start`, req),

  /** The host in a simulive's room before it starts (api/internal/api/simulive_host.go):
   *  start now, start in N minutes / delay / at a moment, cancel that, open the doors early,
   *  and end. Each answers with the webinar as it now is. */
  simuliveStartNow: async (slug: string) => {
    const webinar = await post<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/start-now`);
    dropHostWebinarLists();
    return webinar;
  },
  simuliveStartAt: (slug: string, req: SimuliveScheduleRequest) =>
    put<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/start-at`, req),
  simuliveCancelStart: (slug: string) =>
    del<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/start-at`),
  simuliveOpenDoors: (slug: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/open-doors`),
  /** End the replay early and carry on live with the audience (simulive_host.go). The room
   *  is told, and every browser in it re-joins for the live part. */
  simuliveGoLive: (slug: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/go-live`),
  simuliveEnd: async (slug: string) => {
    const webinar = await post<Webinar>(`/api/host/webinars/${seg(slug)}/simulive/end`);
    dropHostWebinarLists();
    return webinar;
  },

  /** A simulive's Auto mode: the assistant answering new questions from the knowledge. */
  simuliveAuto: (slug: string) =>
    request<SimuliveAutoAnswer>(`/api/host/webinars/${seg(slug)}/replay/auto`, fresh),
  setSimuliveAuto: (slug: string, enabled: boolean) =>
    put<SimuliveAutoAnswer>(`/api/host/webinars/${seg(slug)}/replay/auto`, { enabled } satisfies SimuliveAutoAnswerRequest),

  /** The asker's browser, a few seconds after a question in Auto mode, asking the server to
   *  answer the waiting batch (inline, in this request: see api/internal/api/qa_auto.go). */
  qaAuto: (slug: string, joinKey?: string) =>
    post<QAAutoResponse>(`/api/webinars/${seg(slug)}/qa/auto`, (joinKey ? { joinKey } : {}) satisfies QAAutoRequest),

  /** Takes the assistant's answer back off a question (host and co-hosts). */
  retractAutoAnswer: (slug: string, id: string) =>
    post<StatusResponse>(`/api/host/webinars/${seg(slug)}/questions/${seg(id)}/retract`, {}),

  /** Uploads an image and posts it as a message, in one request.
   *
   *  One call rather than two: an upload that hands back a handle for a second call
   *  leaves orphaned bytes every time the second call does not happen. The response is
   *  the created message, but the client does not need to render it — the server
   *  broadcasts it, and it arrives on the data channel like anybody else's. */
  chatImage: (
    slug: string,
    body: {
      id: string;
      blob: Blob;
      mime: string;
      width: number;
      height: number;
      destination?: string;
      joinKey?: string;
    },
  ) => {
    const q = new URLSearchParams({
      id: body.id,
      w: String(body.width),
      h: String(body.height),
    });
    if (body.destination) q.set("destination", body.destination);
    if (body.joinKey) q.set("joinKey", body.joinKey);
    return request<ChatImageResponse>(
      `/api/webinars/${seg(slug)}/chat/image?${q.toString()}`,
      {
        method: "POST",
        body: body.blob,
        headers: { "Content-Type": body.mime },
      },
    );
  },

  /** Moderation: host, co-host or panelist removing an attendee's message.
   *  The room finds out the same way it finds out about anything else the
   *  server announces — a broadcast on the data channel — so there is
   *  nothing to do with the response beyond knowing the call went through. */
  deleteChatMessage: (slug: string, id: string, joinKey?: string) =>
    del<StatusResponse>(
      `/api/webinars/${seg(slug)}/chat/${seg(id)}` +
        (joinKey ? `?joinKey=${seg(joinKey)}` : ""),
    ),

  // ------------------------------------------------------------------ auth

  signup: (body: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    org?: string;
    title?: string;
  }) => post<SignupResponse>("/api/auth/signup", body),

  login: (email: string, password: string) =>
    post<Account>("/api/auth/login", { email, password }),

  /** Confirms the address from the link in the verification mail. No session. */
  verifyEmail: (token: string) =>
    post<StatusResponse>("/api/auth/email/verify", { token }),

  /** Asks for another link. Rate-limited. Works with no session. */
  resendVerification: (email: string) =>
    post<StatusResponse>("/api/auth/email/resend", { email }),

  /** Mails a password reset link. The same answer whether or not the address has an
   *  account, so the UI cannot say which it was. Rate-limited. No session. */
  forgotPassword: (email: string) =>
    post<StatusResponse>("/api/auth/password/forgot", { email }),

  /** Sets a new password from the reset link, and signs in: the response carries the
   *  session cookie. Every other session on the account is signed out. */
  resetPassword: (token: string, password: string) =>
    post<Account>("/api/auth/password/reset", { token, password }),

  /** Exchange a One Tap Google ID token for the webcast_session cookie. nonce must
   *  match GIS. from "webinar" marks a new account as webinar audience. */
  googleAuth: (idToken: string, nonce?: string, from?: "webinar") =>
    post<Account>("/api/auth/google", {
      idToken,
      ...(nonce ? { nonce } : {}),
      ...(from ? { from } : {}),
    }),

  /** Legacy: exchange a Supabase Auth access token for webcast_session. */
  supabaseAuth: (accessToken: string, googleAccessToken?: string) =>
    post<Account>("/api/auth/supabase", {
      accessToken,
      ...(googleAccessToken ? { googleAccessToken } : {}),
    }),

  logout: () => post<StatusResponse>("/api/auth/logout"),
  /** Erase the signed-in account. Password, or the email for a Google-only account. */
  deleteAccount: (req: DeleteAccountRequest) =>
    del<StatusResponse>("/api/auth/account", req),

  me: (force = false) =>
    cachedGet<Account>(ME_KEY, { ttl: TTL_SESSION, force }),

  updateProfile: (body: ProfilePatch) => patch<Account>("/api/auth/me", body),

  /** The price list. Public; the pricing page renders straight from it so the
   *  page and what Razorpay charges cannot disagree. */
  billingPlans: () => request<BillingCatalogue>("/api/billing/plans", fresh),

  /** Prices a plan on the server and creates the Razorpay order Checkout opens. */
  createBillingOrder: (body: CreateBillingOrderRequest) =>
    post<BillingCheckout>("/api/billing/orders", body),

  /** Checkout's signed success response. Turns hosting on; returns the account. */
  verifyBillingPayment: async (body: VerifyBillingPaymentRequest) => {
    const res = await post<VerifyBillingPaymentResponse>(
      "/api/billing/verify",
      body,
    );
    dropCache(ME_KEY);
    return res;
  },

  myBilling: () => request<BillingStatus>("/api/me/billing", fresh),

  /** Starts the 7-day free trial on a monthly plan: a Razorpay subscription
   *  whose first charge is in seven days. Checkout then authorises it. */
  startTrial: (plan: string) =>
    post<TrialCheckout>("/api/billing/trial", {
      plan,
    } satisfies StartTrialRequest),

  /** Checkout's signed response for the trial's authorisation. Starts the trial. */
  verifyTrial: async (body: VerifyTrialRequest) => {
    const res = await post<VerifyTrialResponse>(
      "/api/billing/trial/verify",
      body,
    );
    dropCache(ME_KEY);
    return res;
  },

  /** Stops the running subscription now, trial or paid; the plan ends with it. */
  cancelSubscription: async () => {
    const res = await post<VerifyTrialResponse>("/api/me/billing/cancel", {});
    dropCache(ME_KEY);
    return res;
  },

  /** Asks to host. Phone is sent only when the account does not already have one.
   *  Does not grant hosting. A second call is refused once a request is open. */
  requestHost: (phone?: string) =>
    post<Account>("/api/me/host-request", phone ? { phone } : {}),

  /** Replaces the account's profile photo. The body is the raw image — see
   *  lib/profile-photo.ts, which crops to a square before this is called.
   *  Returns the account; avatarUrl then points at the stored bytes. */
  uploadAvatar: async (blob: Blob, mime: string) => {
    const me = await request<Account>("/api/auth/avatar", {
      method: "POST",
      body: blob,
      headers: { "Content-Type": mime },
    });
    writeCache(ME_KEY, me);
    return me;
  },

  /** Removes the upload. The account falls back to its Google photo, if any. */
  deleteAvatar: async () => {
    const me = await del<Account>("/api/auth/avatar");
    writeCache(ME_KEY, me);
    return me;
  },

  myRegistrations: (force = false) =>
    cachedGet<RegisteredWebinar[]>(REGISTRATIONS_KEY, {
      ttl: TTL_SESSION,
      force,
    }),

  /** One page of the host portal's Attending tab: other people's sessions this
   *  account registered for, live first then newest start first. `q` matches
   *  the topic or the host's name; `from`/`to`/`cursor` as on hostWebinars.
   *  Not cached: a registration made in another tab has to show up. */
  attending: (params: AttendingQuery = {}) =>
    request<AttendingPage>(attendingPath(params), fresh),

  // ------------------------------------------------------------------ host

  /** One page of the host's own sessions, with every tab's count alongside —
   *  the list is paged server-side, so the badges can't be counted here.
   *  `tab` defaults to upcoming, `q` matches the topic, `from`/`to` are plain
   *  YYYY-MM-DD dates inclusive on both ends, and `cursor` is the previous
   *  page's `nextCursor` (opaque: pass it back, don't read it). */
  hostWebinars: (params: HostWebinarQuery = {}) =>
    cachedGet<HostWebinarPage>(hostWebinarsPath(params), {
      ttl: TTL_LIST,
      key: hostWebinarsKey(params),
    }),
  /** Every session this host has, upcoming and past, for a PICKER rather than a
   *  list — the CRM asks "which webinar is this broadcast about", and a broadcast
   *  to the people who came to last week's is the most obvious one there is, so
   *  an answer that only offered the next ten could not express it.
   *
   *  Walks the cursor, because the list endpoint above is paged and capped at 100
   *  a page. Drafts are left out: a draft has never been scheduled, so nobody has
   *  registered for it and there is nobody to message about it. */
  hostWebinarsForPicker: async (): Promise<Webinar[]> => {
    const hit = readCache<Webinar[]>(HOST_LIST_PICKER_KEY, TTL_SESSION);
    if (hit?.fresh) return hit.value;
    const out: Webinar[] = [];
    for (const tab of ["upcoming", "past"] satisfies HostWebinarTab[]) {
      let cursor = "";
      /* A bound rather than a while(true). Ten pages of 100 is more sessions
       * than any host on this instance has, and a loop whose exit condition is
       * a field the server sends is how one stale cursor becomes a spin. */
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ tab, limit: "100" });
        if (cursor) qs.set("cursor", cursor);
        const res = await request<HostWebinarPage>(
          `/api/host/webinars?${qs.toString()}`,
          fresh,
        );
        out.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
    }
    writeCache(HOST_LIST_PICKER_KEY, out);
    return out;
  },

  hostRecordingLibrary: () =>
    request<Recording[]>("/api/host/recordings", fresh),

  /** Topic tags THIS host has already used, for the schedule form's
   *  suggestions. Scoped to the signed-in coach — another coach's tags are
   *  not this one's taxonomy — so a brand-new tag typed here needs no
   *  separate "create" step: saving the webinar with it is enough for it to
   *  come back as a suggestion next time. */
  hostTracks: () => cachedGet<string[]>(TRACKS_KEY, { ttl: TTL_LIST }),

  /** "Write with AI": a draft title, description, registration copy and social
   *  posts from one line. Saves nothing. Refusals: 403 feature_off, 422,
   *  429 ai_limit / rate_limited, 503 ai_unavailable. */
  aiWebinarSetup: (body: AIWebinarSetupRequest) =>
    post<AIWebinarSetup>("/api/host/ai/webinar-setup", body),

  /** Sessions this account is a panelist on but does not own. */
  stageWebinars: () => request<Webinar[]>("/api/host/stage", fresh),

  hostWebinar: (slug: string) =>
    request<Webinar>(`/api/host/webinars/${seg(slug)}/`, fresh),

  createWebinar: async (body: WebinarInput) => {
    const webinar = await post<Webinar>("/api/host/webinars", body);
    dropHostWebinarLists();
    dropCache(TRACKS_KEY);
    return webinar;
  },

  updateWebinar: async (slug: string, body: WebinarInput) => {
    const webinar = await patch<Webinar>(
      `/api/host/webinars/${seg(slug)}/`,
      body,
    );
    dropCache(TRACKS_KEY);
    return webinar;
  },

  /** Save or clear the host's RTMP destination (YouTube stream key + watch URL). */
  setWebinarStream: (slug: string, body: SetStreamRequest) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/stream`, body),

  /** Browser navigation to Google (not fetch) — needs a top-level redirect. */
  youtubeConnectURL: (returnTo = "/settings") => {
    const next = returnTo.startsWith("/") ? returnTo : "/settings";
    return `${baseFor()}/api/host/youtube/connect?return=${encodeURIComponent(next)}`;
  },

  disconnectYouTube: async () => {
    const account = await del<Account>("/api/host/youtube");
    dropCache(INTEGRATIONS_KEY);
    dropCache(ME_KEY);
    return account;
  },

  hostIntegrations: (force = false) =>
    cachedGet<IntegrationsResponse>(INTEGRATIONS_KEY, {
      ttl: TTL_SESSION,
      force,
    }),

  /** "Notify me" for a coming-soon integration. Returns the card list. */
  integrationInterest: (id: string) =>
    post<IntegrationsResponse>(`/api/host/integrations/${seg(id)}/interest`),

  /** Save a Stream URL and key from a card's stream_key form (LinkedIn Live). href is an /api path. */
  saveStreamKey: async (href: string, body: SaveStreamKeyRequest) => {
    const res = await put<IntegrationsResponse>(href, body);
    dropCache(INTEGRATIONS_KEY);
    return res;
  },

  /** A live-stream platform (linkedin, instagram, facebook) as this room sees
   *  it: key saved, paused here, streaming now. */
  webinarStreamDestination: (slug: string, platform: string) =>
    request<WebinarStreamDestination>(
      `/api/host/webinars/${seg(slug)}/${seg(platform)}`,
      fresh,
    ),
  setWebinarStreamPaused: (slug: string, platform: string, paused: boolean) =>
    patch<WebinarStreamDestination>(
      `/api/host/webinars/${seg(slug)}/${seg(platform)}`,
      { paused } satisfies SetWebinarStreamPausedRequest,
    ),

  /** Follow a card action the registry described (disconnect). href is an /api path. */
  integrationCall: async (href: string, method: "DELETE" | "POST") => {
    const res =
      method === "DELETE"
        ? await del<IntegrationsResponse | Account>(href)
        : await post<IntegrationsResponse | Account>(href);
    dropCache(INTEGRATIONS_KEY);
    return res;
  },

  deleteWebinar: async (slug: string, scope?: "this" | "following") => {
    const q = scope ? `?scope=${scope}` : "";
    const res = await del<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/${q}`,
    );
    dropHostWebinarLists();
    return res;
  },

  /** Copies a webinar into a new draft owned by the same host; returns the draft. */
  copyWebinar: async (slug: string) => {
    const res = await post<Webinar>(`/api/host/webinars/${seg(slug)}/copy`);
    dropHostWebinarLists();
    return res;
  },

  /** Replaces the webinar's cover image. The body is the raw, already-compressed
   *  image — see lib/webinar-image.ts, which crops to 16:9 and re-encodes to at
   *  most 1MB in the browser before this is ever called. Returns the updated
   *  webinar, whose `imageUrl` carries a fresh `?v=` so nothing caches the old
   *  picture under the new URL. */
  uploadWebinarImage: (slug: string, blob: Blob, mime: string) =>
    request<Webinar>(`/api/host/webinars/${seg(slug)}/image`, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": mime },
    }),

  /** Make the cover a copy of one of the host's media library images. */
  setWebinarImageFromMedia: (slug: string, mediaId: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/image/from-media`, {
      mediaId,
    } satisfies WebinarImageFromMediaRequest),

  deleteWebinarImage: (slug: string) =>
    del<Webinar>(`/api/host/webinars/${seg(slug)}/image`),

  startWebinar: async (slug: string) => {
    const webinar = await post<Webinar & { zoomStartUrl?: string }>(
      `/api/host/webinars/${seg(slug)}/start`,
    );
    dropHostWebinarLists();
    return webinar;
  },

  endWebinar: async (slug: string) => {
    const webinar = await post<Webinar>(`/api/host/webinars/${seg(slug)}/end`);
    dropHostWebinarLists();
    return webinar;
  },

  /** Hands ownership to another panelist already in the room, then the caller leaves. */
  transferHost: (slug: string, identity: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/transfer-host`, {
      identity,
    }),

  hostJoin: (slug: string, opts?: { rejoin?: boolean }) =>
    post<JoinResponse>(
      `/api/host/webinars/${seg(slug)}/join${opts?.rejoin ? "?rejoin=1" : ""}`,
    ),
  /** "Try again" after the on-demand video server failed to start (lib/video-server.ts). */
  retryVideoServer: (slug: string) =>
    post<VideoServerStatus>(`/api/host/webinars/${seg(slug)}/server/retry`),
  /** Whether the session's video server is up, for the waiting screen. Read-only. */
  videoServerStatus: (slug: string) =>
    request<VideoServerStatus>(`/api/webinars/${seg(slug)}/server`, fresh),

  // ------------------------------------------------------- in-session controls

  /** Partial by design: only the controls named in the patch change. */
  updateControls: (slug: string, body: ControlsPatch) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/controls`, body),

  /** Server-side captions on or off (the caption agent on the egress host). On also turns
   *  captions on. 503 `server_captions_unavailable` where no agent is deployed — the caller
   *  then turns on ordinary, on-device captions instead. */
  setServerCaptions: (slug: string, body: ServerCaptionsRequest) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/captions/server`, body),

  /** The host's moderation roster, read from the SFU's server API so it
   *  includes the hidden attendees the host's own browser cannot see. */
  participants: (slug: string) =>
    request<LiveRoom>(`/api/host/webinars/${seg(slug)}/participants`, fresh),

  muteAll: (slug: string) =>
    post<MuteAllResponse>(`/api/host/webinars/${seg(slug)}/mute-all`),

  /** "Allow to speak" — mic and screen share, no camera — granted to every
   *  attendee in the room at once. Anyone already a panelist, scheduled or
   *  previously promoted, is left alone; see the API handler. */
  allowAllToSpeak: (slug: string) =>
    post<StageAllResponse>(
      `/api/host/webinars/${seg(slug)}/participants/allow-all`,
    ),

  /** "Bring on stage" — camera, mic and screen share, the full grant — given
   *  to every attendee in the room at once. Anyone already a panelist,
   *  scheduled or previously promoted, is left alone; see the API handler. */
  bringAllOnStage: (slug: string) =>
    post<StageAllResponse>(
      `/api/host/webinars/${seg(slug)}/participants/stage-all`,
    ),

  /** Sends every attendee the host had promoted back to the audience in one
   *  pass — the bulk mirror of "Remove speaker permission". Scheduled
   *  panelists are not touched. */
  revokeAllSpeaking: (slug: string) =>
    post<StageAllResponse>(
      `/api/host/webinars/${seg(slug)}/participants/revoke-all`,
    ),

  /** Mutes one participant, or lets them speak again.
   *
   *  Muting also takes the microphone out of their grant, so it is not something
   *  they can undo. A `status` of "allowed" on the way back means the permission
   *  was restored but they have no live track — only their own browser can open a
   *  microphone, so somebody has to tell them. */
  muteParticipant: (slug: string, identity: string, muted: boolean) =>
    patch<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/participants/${seg(identity)}/mute`,
      { muted },
    ),

  /** Promotes an attendee, or narrows the grant to a microphone only — the
   *  host's "allow to speak". */
  // ------------------------------------------------------------- host: polls
  //
  // The host's view carries the drafts, every tally and every correct answer.

  /** The chat archive: every message including the panelists-only ones the audience
   *  never saw, with the per-session summary a report would otherwise recompute by
   *  reading the whole transcript. */
  chatTranscript: (slug: string) =>
    request<{ stats: ChatStats; messages: ChatTranscriptMessage[] }>(
      `/api/host/webinars/${seg(slug)}/chat`,
      fresh,
    ),

  chatTranscriptCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/chat?format=csv`,

  hostPolls: (slug: string) =>
    request<Poll[]>(`/api/host/webinars/${seg(slug)}/polls`, fresh),

  createPoll: (slug: string, body: PollInput) =>
    post<Poll>(`/api/host/webinars/${seg(slug)}/polls`, body),

  openPoll: (slug: string, id: string) =>
    post<Poll>(`/api/host/webinars/${seg(slug)}/polls/${seg(id)}/open`),

  closePoll: (slug: string, id: string) =>
    post<Poll>(`/api/host/webinars/${seg(slug)}/polls/${seg(id)}/close`),

  deletePoll: (slug: string, id: string) =>
    del<StatusResponse>(`/api/host/webinars/${seg(slug)}/polls/${seg(id)}`),

  setStage: (slug: string, identity: string, role: Role, audioOnly = false) =>
    post<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/participants/${seg(identity)}/stage`,
      { role, audioOnly },
    ),

  respondStageInvite: (
    slug: string,
    body: { joinKey?: string; accept: boolean },
  ) => post<StatusResponse>(`/api/webinars/${seg(slug)}/stage-invite`, body),

  /** Still here while the LiveKit connection is down (lib/presence.ts). */
  presence: (slug: string, body: PresenceRequest) =>
    post<PresenceResponse>(`/api/webinars/${seg(slug)}/presence`, body),

  patchQuestion: (slug: string, id: string, body: QuestionPatch) =>
    patch<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/questions/${seg(id)}`,
      body,
    ),

  /** The live Q&A assistant (host and co-hosts): duplicate questions grouped, and the Top
   *  questions strip. enabled is false while the session may not use AI. */
  qaClusters: (slug: string, signal?: AbortSignal) =>
    request<QAClustersResponse>(`/api/host/webinars/${seg(slug)}/qa/clusters`, {
      ...fresh,
      signal,
    }),

  /** Spam detection's flags on the live chat and Q&A (host and co-hosts only), with the
   *  session's settings. Also what lets a due AI pass run. See api/internal/api/spam.go. */
  spamFlags: (slug: string, signal?: AbortSignal) =>
    request<SpamFlagsResponse>(`/api/host/webinars/${seg(slug)}/spam`, {
      ...fresh,
      signal,
    }),

  spamSettings: (slug: string, body: SpamSettingsPatch) =>
    patch<SpamSettings>(`/api/host/webinars/${seg(slug)}/spam/settings`, body),

  /** One host action on a flagged message: delete, hide, remove, mute, unmute or not_spam. */
  spamAction: (slug: string, kind: "chat" | "question", id: string, action: string) =>
    post<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/spam/${seg(kind)}/${seg(id)}`,
      { action },
    ),

  /** A private draft answer for one cluster: shown to this host only, never posted. */
  suggestQAAnswer: (slug: string, clusterId: string) =>
    post<QASuggestResponse>(
      `/api/host/webinars/${seg(slug)}/qa/clusters/${seg(clusterId)}/suggest`,
      {},
    ),

  /** Posts a draft, as edited, as the host's answer on its cluster's open questions. The
   *  only way a draft reaches the audience. Returns the questions now answered. */
  postQADraft: (slug: string, draftId: string, answer: string) =>
    post<QAPostDraftResponse>(
      `/api/host/webinars/${seg(slug)}/qa/drafts/${seg(draftId)}/post`,
      { answer },
    ),

  discardQADraft: (slug: string, draftId: string) =>
    del<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/qa/drafts/${seg(draftId)}`,
    ),

  // ------------------------------------------------------------------ AI knowledge

  /** The host's AI knowledge library (accounts with the ai feature). */
  knowledgeLibrary: () =>
    request<KnowledgeLibrary>("/api/host/knowledge", fresh),

  addKnowledgeText: (title: string, text: string) =>
    post<KnowledgeDoc>("/api/host/knowledge", { title, text }),

  /** Uploads a PDF, DOCX, TXT or MD file as is; the server extracts its text. */
  uploadKnowledge: (file: File, title = "") => {
    const q = new URLSearchParams({ filename: file.name });
    if (title.trim()) q.set("title", title.trim());
    return request<KnowledgeDoc>(`/api/host/knowledge/upload?${q.toString()}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    });
  },

  knowledgeDoc: (id: string) =>
    request<KnowledgeDocDetail>(`/api/host/knowledge/${seg(id)}`, fresh),

  renameKnowledge: (id: string, title: string) =>
    patch<KnowledgeDoc>(`/api/host/knowledge/${seg(id)}`, { title }),

  deleteKnowledge: (id: string) =>
    del<StatusResponse>(`/api/host/knowledge/${seg(id)}`),

  /** The session host's library, each document ticked unless left out of this session. */
  sessionKnowledge: (slug: string) =>
    request<SessionKnowledge>(
      `/api/host/webinars/${seg(slug)}/knowledge`,
      fresh,
    ),

  setSessionKnowledge: (slug: string, docId: string, included: boolean) =>
    patch<SessionKnowledge>(
      `/api/host/webinars/${seg(slug)}/knowledge/${seg(docId)}`,
      { included },
    ),

  /** Ticks or unticks the host's past answers for one session. */
  setSessionPastAnswers: (slug: string, included: boolean) =>
    patch<SessionKnowledge>(
      `/api/host/webinars/${seg(slug)}/knowledge/past-answers`,
      { included },
    ),

  /** Uploads a zipped Obsidian vault as is; each note becomes a document. */
  importVault: (file: File) =>
    request<KnowledgeVaultImport>(
      `/api/host/knowledge/vault?${new URLSearchParams({ filename: file.name }).toString()}`,
      {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/zip" },
      },
    ),

  /** The host's past answers; the read also harvests ended sessions not yet harvested. */
  pastAnswers: () => request<PastAnswers>("/api/host/knowledge/answers", fresh),

  editPastAnswer: (id: string, question: string, answer: string) =>
    patch<PastAnswerResult>(`/api/host/knowledge/answers/${seg(id)}`, {
      question,
      answer,
    }),

  approvePastAnswer: (id: string, question: string, answer: string) =>
    post<PastAnswerResult>(`/api/host/knowledge/answers/${seg(id)}/approve`, {
      question,
      answer,
    }),

  undoPastAnswer: (id: string) =>
    post<PastAnswerResult>(`/api/host/knowledge/answers/${seg(id)}/undo`, {}),

  deletePastAnswer: (id: string) =>
    del<StatusResponse>(`/api/host/knowledge/answers/${seg(id)}`),

  appendCaption: (slug: string, body: { joinKey?: string; text: string }) =>
    post<StatusResponse>(`/api/webinars/${seg(slug)}/captions`, body),

  transcriptUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/transcript.txt`,

  removeParticipant: (slug: string, identity: string) =>
    del<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/participants/${seg(identity)}`,
    ),

  // ------------------------------------------------------------ recordings
  //
  // Open to the host AND the panelists: whoever is presenting may record their
  // own session and take the file. The audience cannot reach any of it.

  recordings: (slug: string) =>
    request<Recording[]>(`/api/host/webinars/${seg(slug)}/recordings`, fresh),

  /** Claims the one recording slot for this webinar and returns the row to upload
   *  against. `mime` is what this browser can actually produce — Safari records
   *  MP4, Chrome WebM — so the server stores what it is given. */
  startRecording: (slug: string, mime: string) =>
    post<Recording>(`/api/host/webinars/${seg(slug)}/recordings`, { mime }),

  /** Appends the next few seconds. Raw bytes, not JSON: this is a byte stream
   *  being written to the end of a file. */
  recordingChunk: (slug: string, id: string, blob: Blob) =>
    request<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/chunks`,
      {
        method: "POST",
        body: blob,
        headers: { "Content-Type": "application/octet-stream" },
        signal: AbortSignal.timeout(15_000),
      },
    ),

  completeRecording: (slug: string, id: string, durationMs: number) =>
    request<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/complete?durationMs=${Math.round(durationMs)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
    ),

  updateRecordingShare: (
    slug: string,
    id: string,
    body: ShareRecordingRequest,
  ) =>
    patch<Recording>(
      `/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/share`,
      body,
    ),

  deleteRecording: (slug: string, id: string) =>
    del<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/recordings/${seg(id)}`,
    ),

  /** "Keep longer": 3 more months from the current expiry. 409 quota_exceeded when the
   *  host's recording storage is full. */
  keepRecording: (slug: string, id: string) =>
    post<Recording>(`/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/keep`, {}),

  /** "Let it expire": back to the default window, and no more reminders. */
  letRecordingExpire: (slug: string, id: string) =>
    post<Recording>(`/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/let-expire`, {}),

  /** The signed-in host's recording storage meter. */
  recordingStorage: () => request<RecordingStorage>("/api/host/recording-storage", fresh),

  /** The expiry email's one-click "Keep 3 more months". */
  keepRecordingLink: (body: KeepRecordingLinkRequest) =>
    post<KeepRecordingLinkResponse>("/api/host/recordings/keep-link", body),

  /* Uploaded videos for Simulive (api video_upload.go): a multipart upload straight to the
   * bucket, driven by lib/video-uploader.ts, and the video's own routes once it is done. */
  startVideoUpload: (body: StartVideoUploadRequest) => post<VideoUpload>("/api/host/videos/uploads", body),
  videoUploadStatus: (id: string) => request<VideoUpload>(`/api/host/videos/uploads/${seg(id)}`, fresh),
  videoUploadParts: (id: string, parts: number[]) =>
    post<VideoUploadPartsResponse>(`/api/host/videos/uploads/${seg(id)}/parts`, { parts }),
  completeVideoUpload: (id: string, title?: string) =>
    post<Recording>(`/api/host/videos/uploads/${seg(id)}/complete`, title ? { title } : {}),
  cancelVideoUpload: (id: string) => del<StatusResponse>(`/api/host/videos/uploads/${seg(id)}`),
  renameVideo: (id: string, title: string) => patch<Recording>(`/api/host/videos/${seg(id)}`, { title }),
  deleteVideo: (id: string) => del<StatusResponse>(`/api/host/videos/${seg(id)}`),
  keepVideo: (id: string) => post<Recording>(`/api/host/videos/${seg(id)}/keep`, {}),
  videoFileURL: (id: string) => `${API_BASE}/api/host/videos/${seg(id)}/file`,
  /** Where the host plays a recording (or one take of it): an uploaded video has no webinar. */
  recordingPlayURL: (rec: Pick<Recording, "id" | "webinar" | "source">, partId?: string) =>
    rec.source === "upload"
      ? `${API_BASE}/api/host/videos/${seg(rec.id)}/file`
      : `${API_BASE}/api/host/webinars/${seg(rec.webinar)}/recordings/${seg(partId ?? rec.id)}/file`,

  /** The file itself. A plain URL rather than a fetch: the browser streams it,
   *  supports range requests so the video can be scrubbed, and the session cookie
   *  travels with it. */
  recordingFileURL: (slug: string, id: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/file`,

  publicRecording: (slug: string, id: string, passcode?: string) => {
    const qs = passcode ? `?passcode=${encodeURIComponent(passcode)}` : "";
    return request<PublicRecording>(
      `/api/webinars/${seg(slug)}/recordings/${seg(id)}/public${qs}`,
      fresh,
    );
  },

  publicRecordingStreamURL: (slug: string, id: string, passcode?: string) => {
    const qs = passcode ? `?passcode=${encodeURIComponent(passcode)}` : "";
    return `${API_BASE}/api/webinars/${seg(slug)}/recordings/${seg(id)}/stream${qs}`;
  },

  /** A replay's CC, from the session's own captions (lib/caption-track.ts). part is one
   *  take's own file, for the <track> on it. */
  publicRecordingCaptionsURL: (slug: string, id: string, passcode?: string, part?: string) =>
    captionsURL(`${API_BASE}/api/webinars/${seg(slug)}/recordings/${seg(id)}/captions.vtt`, { passcode, part }),

  /** The stage's preview of the same, whether or not the host shows them on replays. */
  recordingCaptionsURL: (slug: string, id: string, part?: string) =>
    captionsURL(`${API_BASE}/api/host/webinars/${seg(slug)}/recordings/${seg(id)}/captions.vtt`, { part }),

  /** A simulive's CC: its recording's original captions. Same credential as the replay. */
  simuliveCaptionsURL: (slug: string, joinKey?: string) =>
    captionsURL(`${API_BASE}/api/webinars/${seg(slug)}/captions.vtt`, { joinKey }),

  // ------------------------------------------------------------ registrants

  hostRegistrants: (
    slug: string,
    page: {
      limit?: number;
      offset?: number;
      sort?: string;
      order?: "asc" | "desc";
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (page.limit) qs.set("limit", String(page.limit));
    if (page.offset) qs.set("offset", String(page.offset));
    if (page.sort) {
      qs.set("sort", page.sort);
      if (page.order) qs.set("order", page.order);
    }
    const s = qs.toString();
    return request<RegistrantPage>(
      `/api/host/webinars/${seg(slug)}/registrants${s ? `?${s}` : ""}`,
      fresh,
    );
  },

  /** The CSV export is a plain link rather than a fetch, so the browser's own
   *  download machinery handles it. */
  registrantsCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/registrants.csv`,

  /** The attendee list of an ended session (host and co-hosts only), a plain link like
   *  the one above. See lib/attendee-export.ts. */
  attendeesCsvUrl: (slug: string, scope: AttendeeScope) =>
    `${API_BASE}${attendeesCsvPath(slug, scope)}`,

  /** The attendance report, now read only for the stage's own rows (the Engagement tab's
   *  "Hosts & panelists" list); its CSV twin is the Export menu's attendance log. */
  sessionReport: (slug: string, signal?: AbortSignal) =>
    request<SessionReport>(`/api/host/webinars/${seg(slug)}/report`, {
      ...fresh,
      signal,
    }),

  /** The AI recap of an ended session: status none / pending / ready / skipped / failed,
   *  with the reason when it is not ready. */
  sessionRecap: (slug: string, signal?: AbortSignal) =>
    request<SessionRecapResponse>(`/api/host/webinars/${seg(slug)}/recap`, {
      ...fresh,
      signal,
    }),

  /** "Generate recap now": a recap waiting for the full transcript is written at once from
   *  what there is. 409 when it is not waiting (already written, skipped or failed). */
  generateRecapNow: (slug: string) =>
    request<SessionRecapResponse>(`/api/host/webinars/${seg(slug)}/recap/generate`, {
      method: "POST",
    }),

  /** Hot leads: everybody, ranked by what they did (counted, not AI), with an AI reason
   *  beside the top ones once the session has ended. aiStatus says why there are none. */
  sessionLeads: (slug: string, signal?: AbortSignal) =>
    request<LeadsResponse>(`/api/host/webinars/${seg(slug)}/leads`, {
      ...fresh,
      signal,
    }),

  /** The follow-up writer's drafts per group, written once after the end. lang is "en" or
   *  "hinglish"; omitted, the session's own language. Refusals: 429 ai_limit, 503
   *  ai_unavailable. */
  sessionFollowups: (slug: string, lang?: string, signal?: AbortSignal) =>
    request<FollowupsResponse>(
      `/api/host/webinars/${seg(slug)}/followups${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
      { ...fresh, signal },
    ),

  /** The follow-ups' review screen: each person's drafts filled in, and what email and
   *  WhatsApp can do for them now. Host only. 409 not_ended / no_drafts, 403 feature_off. */
  followupPlan: (slug: string, keys: string[], group: string, lang: string) =>
    post<FollowupPlanResponse>(
      `/api/host/webinars/${seg(slug)}/followups/plan?group=${encodeURIComponent(group)}`,
      { keys, language: lang } satisfies FollowupPlanRequest,
    ),

  /** Sends what the host reviewed: at most maxPerRequest items per call. 429 rate_limited. */
  followupSend: (slug: string, items: FollowupSendItem[], again: boolean, lang: string) =>
    post<FollowupSendResponse>(
      `/api/host/webinars/${seg(slug)}/followups/send?lang=${encodeURIComponent(lang)}`,
      { items, again } satisfies FollowupSendRequest,
    ),

  /** Save the host's edit of one group's drafts. 409 no_drafts, 422 too_long. */
  saveFollowup: (
    slug: string,
    group: string,
    draft: FollowupDraft,
    lang: string,
  ) =>
    put<FollowupsResponse>(
      `/api/host/webinars/${seg(slug)}/followups/${seg(group)}?lang=${encodeURIComponent(lang)}`,
      { draft },
    ),

  /** Content repurposing: the session's drafts (blog, newsletter, whitepaper, social posts).
   *  A poll also writes anything queued. 403 feature_off without the repurpose switch. */
  repurposeDrafts: (slug: string, signal?: AbortSignal) =>
    request<RepurposeResponse>(`/api/host/webinars/${seg(slug)}/repurpose`, { ...fresh, signal }),

  /** Write (or rewrite) these formats. 409 with the reason (not_ended, no_transcript,
   *  ai_session_off …), 429 ai_limit. */
  generateRepurpose: (slug: string, formats: string[]) =>
    post<RepurposeResponse>(`/api/host/webinars/${seg(slug)}/repurpose`, {
      formats,
    } satisfies RepurposeRequest),

  /** The host's edit of one draft, and whether they have reviewed it. 409 no_draft. */
  saveRepurpose: (slug: string, format: string, markdown: string, reviewed: boolean) =>
    put<RepurposeResponse>(`/api/host/webinars/${seg(slug)}/repurpose/${seg(format)}`, {
      markdown,
      reviewed,
    } satisfies RepurposeEditRequest),

  /** The host's brand voice for repurposed drafts. */
  brandVoice: () => request<BrandVoice>("/api/host/brand-voice", fresh),
  saveBrandVoice: (voice: BrandVoice) => put<BrandVoice>("/api/host/brand-voice", voice),

  hostSurvey: (slug: string) =>
    request<HostSurvey>(`/api/host/webinars/${seg(slug)}/survey`, fresh),

  saveSurvey: (slug: string, body: SurveyInput) =>
    put<Survey>(`/api/host/webinars/${seg(slug)}/survey`, body),

  deleteSurvey: (slug: string) =>
    del<StatusResponse>(`/api/host/webinars/${seg(slug)}/survey`),

  launchSurvey: (slug: string) =>
    post<Survey>(`/api/host/webinars/${seg(slug)}/survey/launch`),

  closeSurvey: (slug: string) =>
    post<Survey>(`/api/host/webinars/${seg(slug)}/survey/close`),

  surveyResults: (slug: string, signal?: AbortSignal) =>
    request<SurveyResults>(`/api/host/webinars/${seg(slug)}/survey/results`, {
      ...fresh,
      signal,
    }),

  surveyAnswers: (
    slug: string,
    question: string,
    cursor?: string,
    limit = 20,
  ) =>
    request<SurveyTextPage>(
      `/api/host/webinars/${seg(slug)}/survey/answers?question=${seg(question)}&limit=${limit}${
        cursor ? `&cursor=${seg(cursor)}` : ""
      }`,
      fresh,
    ),

  reportCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/report.csv`,

  /** The Engagement page's headline read. `state` says why there are no numbers yet;
   *  a live webinar's summary changes, so the page polls it. */
  engagementSummary: (slug: string, signal?: AbortSignal) =>
    request<EngagementSummary>(`/api/host/webinars/${seg(slug)}/engagement`, {
      ...fresh,
      signal,
    }),

  /** One page of the attendee heatmap, sorted, filtered and paged server-side.
   *  `cursor` is the previous page's `nextCursor`, opaque. */
  engagementAttendees: (
    slug: string,
    query: AttendeeQuery,
    signal?: AbortSignal,
  ) =>
    request<EngagementAttendeePage>(
      `/api/host/webinars/${seg(slug)}/engagement/attendees?${toSearchParams(query).toString()}`,
      { ...fresh, signal },
    ),

  engagementAttendee: (slug: string, identity: string, signal?: AbortSignal) =>
    request<EngagementAttendeeDetail>(
      `/api/host/webinars/${seg(slug)}/engagement/attendees/${seg(identity)}`,
      { ...fresh, signal },
    ),

  engagementCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/engagement.csv`,

  recomputeEngagement: (slug: string) =>
    post<EngagementSummary>(
      `/api/host/webinars/${seg(slug)}/engagement/recompute`,
    ),

  /** Who is waiting at a meeting's door, longest-waiting first. Hosts and co-hosts only;
   *  422 `not_a_meeting` for a webinar. Polled by the room's lobby panel, beside the
   *  {kind:"lobby"} packet that says the count changed. */
  meetingLobby: (slug: string) =>
    request<LobbyEntry[]>(`/api/host/webinars/${seg(slug)}/lobby`, fresh),

  /** Let one waiting guest in. 409 `meeting_full` when the room is at its cap. */
  admitLobby: (slug: string, id: string) =>
    post<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/lobby/${seg(id)}/admit`,
    ),

  /** Turn one waiting guest away; their next poll answers `lobby_denied`. */
  denyLobby: (slug: string, id: string) =>
    post<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/lobby/${seg(id)}/deny`,
    ),

  /** Let in as many as fit, oldest first; `left` is how many are still waiting. */
  admitAllLobby: (slug: string) =>
    post<LobbyAdmitAllResponse>(
      `/api/host/webinars/${seg(slug)}/lobby/admit-all`,
    ),

  approveAll: (slug: string) =>
    post<MuteAllResponse>(
      `/api/host/webinars/${seg(slug)}/registrants/approve-all`,
    ),

  setRegistrationState: (id: string, state: string) =>
    patch<StatusResponse>(`/api/host/registrations/${seg(id)}`, { state }),

  /** Just the queue: rows awaiting a decision. Separate from hostRegistrants, which
   *  returns everybody in every state and is what the roster table shows. */
  pendingApprovals: (slug: string) =>
    request<RegistrantRow[]>(
      `/api/host/webinars/${seg(slug)}/approvals`,
      fresh,
    ),

  /** One decision for a chosen set of rows, in one atomic request.
   *
   *  The alternative was N calls to setRegistrationState, which is what the panel did
   *  before: a host ticking forty boxes fired forty requests, and a failure halfway
   *  through left half the room approved with nothing to say which half. */
  decideApprovals: (slug: string, ids: string[], state: RegistrationState) =>
    patch<ApprovalsResponse>(`/api/host/webinars/${seg(slug)}/approvals`, {
      ids,
      state,
    }),

  // ---------------------------------------------------------------- admin

  /** Aggregates for the admin dashboard.
   *
   *  Not derived here from adminUsers and adminWebinars. The account list is
   *  capped, and the webinar list is every full record — both the wrong read
   *  for "how many are live". */
  adminStats: () => request<AdminStats>("/api/admin/stats", fresh),
  /** Which WhatsApp CRM features hosts used over the last 7, 30 or 90 days. */
  adminWhatsAppUsage: (days: 7 | 30 | 90) =>
    request<AdminWhatsAppUsage>(
      `/api/admin/stats/whatsapp?days=${days}`,
      fresh,
    ),

  /** Every host's recorded usage over a date range (YYYY-MM-DD, inclusive), for the
   *  Cost by host report; priced in the browser (lib/host-costs.ts). */
  adminCosts: (q: { from?: string; to?: string; provider?: string; fresh?: boolean }) =>
    request<AdminCostsResponse>(`/api/admin/costs?${costQuery(q)}`, fresh),
  /** One host's usage and their sessions, for the drill-down. */
  adminCostHost: (id: string, q: { from?: string; to?: string; provider?: string; fresh?: boolean }) =>
    request<AdminCostHostDetail>(`/api/admin/costs/hosts/${seg(id)}?${costQuery(q)}`, fresh),
  /** The on-demand video server: its state, recent droplets and hours in the last 30 days. */
  adminSfuBox: () => request<AdminSFUBox>("/api/admin/sfu-box", fresh),
  /** The report's ignore list (test and staff accounts), with rules worth adding. */
  costIgnoreList: () => request<CostIgnoreList>("/api/admin/costs/ignore", fresh),
  addCostIgnoreRule: (rule: CostIgnoreRuleInput) => post<CostIgnoreRule>("/api/admin/costs/ignore", rule),
  deleteCostIgnoreRule: (id: string) => del<StatusResponse>(`/api/admin/costs/ignore/${seg(id)}`),

  /** Every account, for the admin panel. Admin-only server side; `q` filters by
   *  email or name. */
  adminUsers: (q = "", kind: AccountKind = "customer") =>
    request<AdminUser[]>(
      `/api/admin/users?kind=${kind}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      fresh,
    ),

  /** How many accounts are in each admin list (customers, webinar audience). */
  adminAccountCounts: () =>
    request<AdminAccountCounts>("/api/admin/users/counts", fresh),

  /** Move an account between the customer list and the webinar-audience list.
   *  Does not grant or remove hosting. */
  setAccountKind: (userId: string, kind: AccountKind) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/kind`, {
      kind,
    } satisfies SetAccountKindRequest),

  /** Grant or revoke the hosting capability. A PATCH stating what the value should BE,
   *  not a grant/revoke pair, so a retried request cannot double-apply. */
  setHostCapability: (userId: string, canHost: boolean) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/host`, { canHost }),

  /** Switches one per-account feature on or off — the admin deciding what an
   *  account has bought. One feature per request, stating the state it should end
   *  in, so two admins on two screens cannot overwrite each other's decisions
   *  about switches neither of them touched. The keys come from
   *  `config.featureCatalogue`, never from a list written here. */
  setUserFeature: (userId: string, feature: string, enabled: boolean) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/features`, {
      feature,
      enabled,
    } satisfies FeatureGrant),

  /** Sets this account's override for one feature: true forces it on, false off,
   *  null clears it so the account's plan decides. */
  setUserFeatureOverride: (
    userId: string,
    feature: string,
    state: boolean | null,
  ) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/features`, {
      feature,
      enabled: state === true,
      inherit: state === null,
    } satisfies FeatureGrant),

  /** Several switches for one account in one request (PUT …/features): each grant is the
   *  end state, the rest are left as they are. Refused whole on an unknown key. */
  setUserFeatures: (userId: string, grants: FeatureGrant[]) =>
    put<Account>(`/api/admin/users/${seg(userId)}/features`, { grants } satisfies FeatureGrants),

  /** The tier matrix: which features each plan includes. */
  planFeatures: () =>
    request<PlanFeaturesBody>("/api/admin/plan-features", fresh),

  /** Replaces the tier matrix whole. */
  setPlanFeatures: (tiers: PlanFeatures[]) =>
    put<PlanFeaturesBody>("/api/admin/plan-features", {
      tiers,
    } satisfies PlanFeaturesBody),

  /** Set a custom number of people on stage for an account; null goes back to its plan. */
  setUserStageCap: (userId: string, stageCap: number | null) =>
    patch<StatusResponse>(`/api/admin/users/${seg(userId)}/stage-cap`, {
      stageCap: stageCap ?? undefined,
    } satisfies SetUserStageCapRequest),
  /** Set how many people one of an account's meetings holds; null goes back to its plan. */
  setUserMeetingCap: (userId: string, meetingCap: number | null) =>
    patch<StatusResponse>(`/api/admin/users/${seg(userId)}/meeting-cap`, {
      meetingCap: meetingCap ?? undefined,
    } satisfies SetUserMeetingCapRequest),

  /** Set a custom max meeting duration for a user in minutes. Pass null to reset to system default. */
  setUserMaxDuration: (userId: string, maxDurationMin: number | null) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/max-duration`, {
      maxDurationMin,
    }),

  /** Set an account's media library limit in bytes; null puts it back on the default. */
  setUserMediaQuota: (userId: string, mediaQuotaBytes: number | null) =>
    // An absent field is null to the server: back on the default.
    patch<SetUserMediaQuotaRequest>(
      `/api/admin/users/${seg(userId)}/media-quota`,
      {
        mediaQuotaBytes: mediaQuotaBytes ?? undefined,
      } satisfies SetUserMediaQuotaRequest,
    ),

  /** Set an account's recording storage (bytes) and default retention (days); null puts
   *  either back on the plan / deployment default. Both are always sent. */
  setUserRecordingStorage: (
    userId: string,
    recordingQuotaBytes: number | null,
    recordingRetentionDays: number | null,
  ) =>
    patch<RecordingStorage>(`/api/admin/users/${seg(userId)}/recording-storage`, {
      recordingQuotaBytes: recordingQuotaBytes ?? undefined,
      recordingRetentionDays: recordingRetentionDays ?? undefined,
    } satisfies SetUserRecordingStorageRequest),

  /** Put an account on a paid plan, or "" for none (the launch default). */
  setUserPlan: (userId: string, plan: Plan | "") =>
    patch<Account>(`/api/admin/users/${seg(userId)}/plan`, {
      plan,
    } satisfies SetUserPlanRequest),

  /** The configured video servers (LiveKit projects): ids and labels, never secrets. */
  sfuProjects: () =>
    request<SFUProjectsResponse>("/api/admin/sfu-projects", fresh),

  /** Send a host's NEW webinars to a video server, or "" for the default order. */
  setUserSFU: (userId: string, project: string) =>
    patch<SetUserSFURequest>(`/api/admin/users/${seg(userId)}/sfu`, {
      project,
    } satisfies SetUserSFURequest),

  /** Lets an account take one more free trial past the once-per-person check. */
  allowAnotherTrial: (userId: string) =>
    post<StatusResponse>(`/api/admin/users/${seg(userId)}/trial-exemption`, {}),

  /** Clears an account's payment-method review flags. */
  clearTrialFlags: (userId: string) =>
    del<StatusResponse>(`/api/admin/users/${seg(userId)}/trial-flags`),

  /** Deletes an account outright. Refused by the server for the caller's own
   *  account, and for one that still hosts webinars — those have to be
   *  deleted first, as their own explicit action. */
  adminDeleteUser: (userId: string) =>
    del<StatusResponse>(`/api/admin/users/${seg(userId)}`),

  /** Every webinar on the instance, across every host — unlike every other
   *  listing in this file, which is scoped to the signed-in account. `status`
   *  is "scheduled" | "live" | "ended"; `from`/`to` are plain YYYY-MM-DD dates,
   *  inclusive on both ends; `q` matches the topic. All optional. */
  adminWebinars: (
    filter: {
      status?: "draft" | "scheduled" | "live" | "ended";
      from?: string;
      to?: string;
      q?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
    if (filter.q) params.set("q", filter.q);
    const qs = params.toString();
    return request<Webinar[]>(
      `/api/admin/webinars${qs ? `?${qs}` : ""}`,
      fresh,
    );
  },

  /** Deletes any webinar on the instance, regardless of who hosts it — the
   *  same teardown the host's own delete performs (room closed if live, every
   *  row and file removed), just reachable without owning it. */
  adminDeleteWebinar: (slug: string) =>
    del<StatusResponse>(`/api/admin/webinars/${seg(slug)}`),

  // ---------------------------------------------------------- sales chat (admin)

  /** The sales inbox. Opening it is also what tells visitors the team is online. */
  adminSalesInbox: (filter: "needs" | "ai" | "closed" | "") =>
    request<SalesInbox>(`/api/admin/sales?filter=${filter}`, fresh),
  adminSalesConversation: (id: string, after = 0) =>
    request<SalesConversationDetail>(
      `/api/admin/sales/${seg(id)}?after=${after}`,
      fresh,
    ),
  adminSalesJoin: (id: string, after = 0) =>
    post<SalesConversationDetail>(
      `/api/admin/sales/${seg(id)}/join?after=${after}`,
    ),
  /** via "" sends to the chat while the visitor is there, and by email once they have left. */
  adminSalesReply: (
    id: string,
    body: string,
    via: "" | "chat" | "email",
    after = 0,
  ) =>
    post<SalesConversationDetail>(
      `/api/admin/sales/${seg(id)}/messages?after=${after}`,
      { body, via },
    ),
  adminSalesClose: (id: string, after = 0) =>
    post<SalesConversationDetail>(
      `/api/admin/sales/${seg(id)}/close?after=${after}`,
    ),

  /** The AI model chain: which provider is answering, and which are paused
   *  (out of free quota, rate limited, or misconfigured) and until when. */
  adminAI: () => request<AIStatus>("/api/admin/ai", fresh),

  // ---------------------------------------------------------- host alerts

  /** The notification bell. Not scoped to a webinar: an alert's job is to tell a host
   *  about a session they are not currently looking at. */
  hostAlerts: () => request<AlertsResponse>("/api/host/alerts", fresh),

  /** An empty list means "all of them", which is what Mark all read sends. */
  readHostAlerts: (ids: string[] = []) =>
    post<MuteAllResponse>("/api/host/alerts/read", { ids }),

  /** "Mark all as read". Replies with the badge count afterwards. */
  readAllHostAlerts: () =>
    post<AlertsChangedResponse>("/api/host/alerts/read-all", {}),

  /** The ✕ on one notification: gone from the panel for good (404 if already gone). */
  dismissHostAlert: (id: string) =>
    del<AlertsChangedResponse>(`/api/host/alerts/${seg(id)}`),

  /** "Clear all": every notification dismissed. */
  dismissAllHostAlerts: () =>
    post<AlertsChangedResponse>("/api/host/alerts/dismiss-all", {}),

  addPanelist: (slug: string, email: string) =>
    post<Person>(`/api/host/webinars/${seg(slug)}/panelists`, { email }),

  removePanelist: (slug: string, userId: string) =>
    del<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/panelists/${seg(userId)}`,
    ),

  /** Makes a panelist the host's equal for this run of the webinar, or turns
   *  them back into an ordinary panelist. See CoHostPatch. */
  setCoHost: (slug: string, userId: string, coHost: boolean) =>
    patch<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/panelists/${seg(userId)}/co-host`,
      { coHost } satisfies CoHostPatch,
    ),
};

export type {
  Account,
  AttendingPage,
  AppConfig,
  JoinResponse,
  LiveRoom,
  PublicRecording,
  RegisteredWebinar,
  Registration,
  RegistrantRow,
  ShareRecordingRequest,
  Webinar,
  WebinarInput,
};

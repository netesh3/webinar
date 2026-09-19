import type {
  Account,
  AdminUser,
  AlertsResponse,
  APIError,
  AppConfig,
  ApprovalsResponse,
  ChatBacklog,
  ChatImageResponse,
  ChatStats,
  ChatMessage as ChatTranscriptMessage,
  CoHostPatch,
  ControlsPatch,
  JoinResponse,
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
  RegistrantRow,
  RegistrationState,
  Role,
  SendMessageRequest,
  SendMessageResponse,
  SessionReport,
  ShareRecordingRequest,
  StageAllResponse,
  StatusResponse,
  Webinar,
  WebinarInput,
} from "./api-types";

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
const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
const INTERNAL_BASE = process.env.API_INTERNAL_URL || PUBLIC_BASE;

/** The browser-facing base. Exported for the handful of places that build a URL
 *  for the browser to fetch directly — a `<video src>`, a download link. */
export const API_BASE = PUBLIC_BASE;

function baseFor(): string {
  return typeof window === "undefined" ? INTERNAL_BASE : PUBLIC_BASE;
}

/** Thrown for any non-2xx. Carries the API's structured error so forms can
 *  render per-field messages. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseFor()}${path}`, {
      ...init,
      // The session is an httpOnly cookie, so it must be sent cross-origin
      // (:3000 -> :8080).
      credentials: "include",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // fetch only rejects on network failure — surface that as something the UI
    // can distinguish from a 500.
    throw new ApiError(0, "network", "Could not reach the server.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body on an error status (a proxy's HTML 502 page, say) must
      // not turn into a SyntaxError that hides the real status code.
      if (!res.ok) {
        throw new ApiError(
          res.status,
          "unexpected_response",
          `Request failed (${res.status})`,
        );
      }
      throw new ApiError(
        res.status,
        "unexpected_response",
        "The server sent something unreadable.",
      );
    }
  }

  if (!res.ok) {
    const err = (body ?? {}) as APIError;
    throw new ApiError(
      res.status,
      err.error ?? "unknown",
      err.message ?? `Request failed (${res.status})`,
      err.fields,
    );
  }
  return body as T;
}

const seg = (s: string) => encodeURIComponent(s);

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/** Reads are never cached: a stale registrant count or a stale "live" badge is
 *  worse than a round trip. */
const fresh = { cache: "no-store" } as const;

// ------------------------------------------------------------------- public

export const api = {
  /** Branding, public URLs and limits an operator sets. Read once at boot so no
   *  such value is baked into the bundle. */
  config: () => request<AppConfig>("/api/config", fresh),

  /** What THIS account may see: hosted, presenting, or registered. Requires a
   *  session — an anonymous caller gets 401, not an empty list, because "nothing
   *  for you" and "who are you" need different screens. */
  listWebinars: () => request<Webinar[]>("/api/webinars", fresh),

  /** One webinar by slug, and deliberately still public: a registration link has
   *  to work for somebody who has no account yet. */
  getWebinar: (slug: string) =>
    request<Webinar>(`/api/webinars/${seg(slug)}`, fresh),

  register: (slug: string, body: RegisterRequest) =>
    post<Registration>(`/api/webinars/${seg(slug)}/register`, body),

  /** Resolves locally-held join keys back into registrations, WITH the webinar
   *  attached. The webinar used to be looked up from the public catalogue; there
   *  is no public catalogue any more, so the answer has to be self-contained or a
   *  guest who registered without an account could never see what they signed up
   *  for. */
  lookup: (joinKeys: string[]) =>
    post<RegisteredWebinar[]>("/api/registrations/lookup", { joinKeys }),

  /** The name-only door: creates a registration and returns a token in one call.
   *
   *  Refused with 409 `guest_join_disabled` when the host approves each attendee, and
   *  403 `passcode_required` when there is a passcode — both of which the landing page
   *  already knows from `webinar.guestJoinAllowed`, so reaching either means the webinar
   *  changed while the page was open. The response carries `joinKey`, which is the only
   *  thing that gets a guest back in after a reload. */
  guestJoin: (slug: string, name: string) =>
    post<JoinResponse>(`/api/webinars/${seg(slug)}/guest-join`, { name }),

  /** Exchanges a join key — or the session cookie — for a LiveKit token. The
   *  server decides the role; a client cannot ask for one. */
  join: (slug: string, joinKey?: string) =>
    post<JoinResponse>(
      `/api/webinars/${seg(slug)}/join`,
      joinKey ? { joinKey } : {},
    ),

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
  }) => post<Account>("/api/auth/signup", body),

  login: (email: string, password: string) =>
    post<Account>("/api/auth/login", { email, password }),

  /** Exchange a Supabase Auth access token for the webcast_session cookie. */
  supabaseAuth: (accessToken: string) =>
    post<Account>("/api/auth/supabase", { accessToken }),

  logout: () => post<StatusResponse>("/api/auth/logout"),

  me: () => request<Account>("/api/auth/me", fresh),

  updateProfile: (body: ProfilePatch) => patch<Account>("/api/auth/me", body),

  myRegistrations: () =>
    request<RegisteredWebinar[]>("/api/me/registrations", fresh),

  // ------------------------------------------------------------------ host

  hostWebinars: () => request<Webinar[]>("/api/host/webinars", fresh),
  hostRecordingLibrary: () => request<Recording[]>("/api/host/recordings", fresh),

  /** Sessions this account is a panelist on but does not own. */
  stageWebinars: () => request<Webinar[]>("/api/host/stage", fresh),

  hostWebinar: (slug: string) =>
    request<Webinar>(`/api/host/webinars/${seg(slug)}/`, fresh),

  createWebinar: (body: WebinarInput) =>
    post<Webinar>("/api/host/webinars", body),

  updateWebinar: (slug: string, body: WebinarInput) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/`, body),

  deleteWebinar: (slug: string) =>
    del<StatusResponse>(`/api/host/webinars/${seg(slug)}/`),

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

  deleteWebinarImage: (slug: string) =>
    del<Webinar>(`/api/host/webinars/${seg(slug)}/image`),

  startWebinar: (slug: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/start`),

  endWebinar: (slug: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/end`),

  /** Hands ownership to another panelist already in the room, then the caller leaves. */
  transferHost: (slug: string, identity: string) =>
    post<Webinar>(`/api/host/webinars/${seg(slug)}/transfer-host`, { identity }),

  hostJoin: (slug: string) =>
    post<JoinResponse>(`/api/host/webinars/${seg(slug)}/join`),

  // ------------------------------------------------------- in-session controls

  /** Partial by design: only the controls named in the patch change. */
  updateControls: (slug: string, body: ControlsPatch) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/controls`, body),

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
    post<StageAllResponse>(`/api/host/webinars/${seg(slug)}/participants/allow-all`),

  /** "Bring on stage" — camera, mic and screen share, the full grant — given
   *  to every attendee in the room at once. Anyone already a panelist,
   *  scheduled or previously promoted, is left alone; see the API handler. */
  bringAllOnStage: (slug: string) =>
    post<StageAllResponse>(`/api/host/webinars/${seg(slug)}/participants/stage-all`),

  /** Sends every attendee the host had promoted back to the audience in one
   *  pass — the bulk mirror of "Remove speaker permission". Scheduled
   *  panelists are not touched. */
  revokeAllSpeaking: (slug: string) =>
    post<StageAllResponse>(`/api/host/webinars/${seg(slug)}/participants/revoke-all`),

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

  patchQuestion: (slug: string, id: string, body: QuestionPatch) =>
    patch<StatusResponse>(
      `/api/host/webinars/${seg(slug)}/questions/${seg(id)}`,
      body,
    ),

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

  // ------------------------------------------------------------ registrants

  hostRegistrants: (slug: string) =>
    request<RegistrantRow[]>(
      `/api/host/webinars/${seg(slug)}/registrants`,
      fresh,
    ),

  /** The CSV export is a plain link rather than a fetch, so the browser's own
   *  download machinery handles it. */
  registrantsCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/registrants.csv`,

  sessionReport: (slug: string) =>
    request<SessionReport>(`/api/host/webinars/${seg(slug)}/report`, fresh),

  reportCsvUrl: (slug: string) =>
    `${API_BASE}/api/host/webinars/${seg(slug)}/report.csv`,

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

  /** Every account, for the admin panel. Admin-only server side; `q` filters by
   *  email or name. */
  adminUsers: (q = "") =>
    request<AdminUser[]>(
      `/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      fresh,
    ),

  /** Grant or revoke the hosting capability. A PATCH stating what the value should BE,
   *  not a grant/revoke pair, so a retried request cannot double-apply. */
  setHostCapability: (userId: string, canHost: boolean) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/host`, { canHost }),

  /** Set a custom max meeting duration for a user in minutes. Pass null to reset to system default. */
  setUserMaxDuration: (userId: string, maxDurationMin: number | null) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/max-duration`, { maxDurationMin }),

  /** Configure whether an account's webinars stream to audience attendees via CDN HLS. */
  setCdnBroadcastCapability: (userId: string, canCdnBroadcast: boolean) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/cdn-broadcast`, { canCdnBroadcast }),

  /** Deletes an account outright. Refused by the server for the caller's own
   *  account, and for one that still hosts webinars — those have to be
   *  deleted first, as their own explicit action. */
  adminDeleteUser: (userId: string) =>
    del<StatusResponse>(`/api/admin/users/${seg(userId)}`),

  /** Every webinar on the instance, across every host — unlike every other
   *  listing in this file, which is scoped to the signed-in account. `status`
   *  is "scheduled" | "live" | "ended"; `from`/`to` are plain YYYY-MM-DD dates,
   *  inclusive on both ends; `q` matches the topic. All optional. */
  adminWebinars: (filter: {
    status?: "draft" | "scheduled" | "live" | "ended";
    from?: string;
    to?: string;
    q?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
    if (filter.q) params.set("q", filter.q);
    const qs = params.toString();
    return request<Webinar[]>(`/api/admin/webinars${qs ? `?${qs}` : ""}`, fresh);
  },

  /** Deletes any webinar on the instance, regardless of who hosts it — the
   *  same teardown the host's own delete performs (room closed if live, every
   *  row and file removed), just reachable without owning it. */
  adminDeleteWebinar: (slug: string) =>
    del<StatusResponse>(`/api/admin/webinars/${seg(slug)}`),

  // ---------------------------------------------------------- host alerts

  /** The notification bell. Not scoped to a webinar: an alert's job is to tell a host
   *  about a session they are not currently looking at. */
  hostAlerts: () => request<AlertsResponse>("/api/host/alerts", fresh),

  /** An empty list means "all of them", which is what Mark all read sends. */
  readHostAlerts: (ids: string[] = []) =>
    post<MuteAllResponse>("/api/host/alerts/read", { ids }),

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

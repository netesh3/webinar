import type {
  Account,
  AdminStats,
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
  CRMAudienceResponse,
  CRMBotPauseRequest,
  CRMBotRequest,
  CRMBotResponse,
  CRMBotsResponse,
  CRMBroadcast,
  CRMBroadcastRequest,
  CRMBroadcastsResponse,
  CRMContact,
  CRMContactsResponse,
  CRMDripEnrollRequest,
  CRMDripRequest,
  CRMDripResponse,
  CRMDripsResponse,
  CRMContactTagRequest,
  CRMMessage,
  CRMNote,
  CRMNoteRequest,
  CRMNotesResponse,
  CRMRemindersRequest,
  CRMRemindersResponse,
  CRMSendRequest,
  CRMSetup,
  CRMTag,
  CRMTagRequest,
  CRMTagsResponse,
  CRMTemplatesResponse,
  CRMThreadResponse,
  FeatureGrant,
  HostWebinarPage,
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
  SetStreamRequest,
  Webinar,
  WebinarInput,
  WhatsAppCallbackRequest,
  WhatsAppRegisterRequest,
  WhatsAppSignup,
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

/* Which bucket of the host's own list to read — the three tabs the host portal
 * shows, and the `tab` parameter the API takes, which are deliberately the same
 * three words so a tab click needs no translation.
 *
 * Spelled out here rather than taken from api-types.ts because tygo renders a
 * Go string type as `string`, which would accept "upcomming" silently. Same
 * reason adminWebinars inlines its own status union. */
export type HostWebinarTab = "upcoming" | "past" | "drafts";

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

  /** One page of the host's own sessions, with every tab's count alongside —
   *  the list is paged server-side, so the badges can't be counted here.
   *  `tab` defaults to upcoming, `q` matches the topic, `from`/`to` are plain
   *  YYYY-MM-DD dates inclusive on both ends, and `cursor` is the previous
   *  page's `nextCursor` (opaque: pass it back, don't read it). */
  hostWebinars: (
    params: {
      tab?: HostWebinarTab;
      q?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.tab) qs.set("tab", params.tab);
    if (params.q) qs.set("q", params.q);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const s = qs.toString();
    return request<HostWebinarPage>(
      `/api/host/webinars${s ? `?${s}` : ""}`,
      fresh,
    );
  },
  /** Every session this host has, upcoming and past, for a PICKER rather than a
   *  list — the CRM asks "which webinar is this broadcast about", and a broadcast
   *  to the people who came to last week's is the most obvious one there is, so
   *  an answer that only offered the next ten could not express it.
   *
   *  Walks the cursor, because the list endpoint above is paged and capped at 100
   *  a page. Drafts are left out: a draft has never been scheduled, so nobody has
   *  registered for it and there is nobody to message about it. */
  hostWebinarsForPicker: async (): Promise<Webinar[]> => {
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
    return out;
  },

  hostRecordingLibrary: () => request<Recording[]>("/api/host/recordings", fresh),

  /** Sessions this account is a panelist on but does not own. */
  stageWebinars: () => request<Webinar[]>("/api/host/stage", fresh),

  hostWebinar: (slug: string) =>
    request<Webinar>(`/api/host/webinars/${seg(slug)}/`, fresh),

  createWebinar: (body: WebinarInput) =>
    post<Webinar>("/api/host/webinars", body),

  updateWebinar: (slug: string, body: WebinarInput) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/`, body),

  /** Save or clear the host's RTMP destination (YouTube stream key + watch URL). */
  setWebinarStream: (slug: string, body: SetStreamRequest) =>
    patch<Webinar>(`/api/host/webinars/${seg(slug)}/stream`, body),

  /** Browser navigation to Google (not fetch) — needs a top-level redirect. */
  youtubeConnectURL: (returnTo = "/account") => {
    const next = returnTo.startsWith("/") ? returnTo : "/account";
    return `${baseFor()}/api/host/youtube/connect?return=${encodeURIComponent(next)}`;
  },

  disconnectYouTube: () => del<Account>("/api/host/youtube"),

  /* Connect WhatsApp — a payload, not a redirect. Meta's Embedded Signup is a JS
   * SDK dialog (see lib/whatsapp-signup.ts), so the browser asks for the app and
   * configuration ids, opens the dialog itself, and posts the resulting code back
   * to be exchanged server-side. Nothing here ever holds the host's token. */
  whatsappSignup: () =>
    request<WhatsAppSignup>("/api/host/whatsapp/connect", fresh),

  connectWhatsApp: (body: WhatsAppCallbackRequest) =>
    post<Account>("/api/host/whatsapp/callback", body),

  disconnectWhatsApp: () => del<Account>("/api/host/whatsapp"),

  /* Registers the connected number with Cloud API, using a PIN the host types.
   *
   * The PIN goes straight out in this request and is never kept: not in state
   * after the call, not in localStorage, not in a log line. If a host forgets
   * it, Meta's two-step settings is where it is reset — this server cannot say
   * what it was, which is the point of not holding it. */
  registerWhatsAppNumber: (pin: string) =>
    post<Account>("/api/host/whatsapp/register", {
      pin,
    } satisfies WhatsAppRegisterRequest),

  // ------------------------------------------------------------------- crm

  /** The host's own contacts, most recent activity first.
   *
   *  `q` matches name, email or number. The server clamps the page size, so a
   *  caller cannot ask for everybody at once — the CRM is meant to be searched
   *  rather than scrolled.
   *
   *  `webinarId` is a slug, and narrows the list to the people who registered for
   *  that one webinar — which is what the link from a webinar's Attendees tab asks
   *  for. Spelled as the audience endpoint spells it. A slug that is not this
   *  host's answers 404 rather than an empty list, so the caller can tell a stale
   *  link from a webinar nobody came to.
   *
   *  `status` is one of the CRMStatus* values and narrows to one of the chips above
   *  the list — who has written back, who can still be messaged. The counts come back
   *  whole either way, so the other chips still say how many they hold while one of
   *  them is active. A value the server does not know is a 422 rather than an
   *  unfiltered list, since those two look identical on screen. */
  crmContacts: (q = "", webinarId = "", limit = 0, status = "") => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (webinarId.trim()) params.set("webinarId", webinarId.trim());
    if (limit > 0) params.set("limit", String(limit));
    if (status.trim()) params.set("status", status.trim());
    const query = params.toString();
    return request<CRMContactsResponse>(
      `/api/host/crm/contacts${query ? `?${query}` : ""}`,
      fresh,
    );
  },

  /** How far along this host is in making WhatsApp work: connected, number
   *  registered, templates synced, a template chosen per automatic message, and the
   *  per-webinar switch turned on somewhere.
   *
   *  One call rather than four, because "done" is the server's rule — a template Meta
   *  paused yesterday un-does a step nobody touched — and because four requests can
   *  render a half-updated mix of each other. It reads the template cache and never
   *  asks Meta, so arriving at the CRM costs nothing. */
  crmSetup: () => request<CRMSetup>("/api/host/crm/setup", fresh),

  /** One contact and the conversation with them. 404 for a contact that is not
   *  this host's — there is no distinction to draw for the caller between "no
   *  such contact" and "not yours". */
  crmThread: (id: string) =>
    request<CRMThreadResponse>(`/api/host/crm/contacts/${seg(id)}`, fresh),

  /** Records that a contact asked not to be messaged — the manual half of the
   *  inbound "STOP" the webhook honours automatically. There is deliberately no
   *  matching opt-IN call: consent comes from the person, not from the party who
   *  benefits from having it. */
  crmOptOut: (id: string) =>
    post<CRMContact>(`/api/host/crm/contacts/${seg(id)}/opt-out`),

  /** The host's labels with a count of who carries each. Also arrives with the
   *  contacts list, so the picker does not need this — it is the tag manager's
   *  own call, and what a rename or a delete returns to. */
  crmTags: () => request<CRMTagsResponse>("/api/host/crm/tags", fresh),

  /** Creates a label, or answers with the existing one of that name. A duplicate
   *  is not an error: a host typing a label they have used before is asking for
   *  that label, and what they want back either way is the tag to apply. */
  createCrmTag: (name: string) =>
    post<CRMTag>("/api/host/crm/tags", { name } satisfies CRMTagRequest),

  /** Renames a label everywhere it is applied — same id, same people, new word.
   *  409 for a name another label already has, because merging two segments is a
   *  real operation and not something to do because two names collided. */
  renameCrmTag: (id: string, name: string) =>
    patch<CRMTag>(`/api/host/crm/tags/${seg(id)}`, {
      name,
    } satisfies CRMTagRequest),

  /** Deletes a label and takes it off everybody who had it. Refused (409) while a
   *  drip sequence triggers on it: an empty trigger means "any tag", so letting
   *  the tag go would widen that rule to every label instead of breaking it. */
  deleteCrmTag: (id: string) =>
    del<StatusResponse>(`/api/host/crm/tags/${seg(id)}`),

  /** Puts a label on somebody. Idempotent, and that matters more than it looks:
   *  `tag_added` starts a sequence, so a second click on the same chip must not
   *  start a second run of paid messages. Answers with the contact's whole set. */
  addCrmContactTag: (id: string, tagId: string) =>
    post<CRMTagsResponse>(`/api/host/crm/contacts/${seg(id)}/tags`, {
      tagId,
    } satisfies CRMContactTagRequest),

  /** Takes a label off one contact. The sequence it started is not rewound, and
   *  re-applying the label later does not start it again — the person has been
   *  through it. */
  removeCrmContactTag: (id: string, tagId: string) =>
    del<CRMTagsResponse>(
      `/api/host/crm/contacts/${seg(id)}/tags/${seg(tagId)}`,
    ),

  /** One contact's notes, newest first. Already on the thread response, so this
   *  is for after writing or deleting one rather than for the first render. */
  crmNotes: (id: string) =>
    request<CRMNotesResponse>(`/api/host/crm/contacts/${seg(id)}/notes`, fresh),

  /** Writes a private note. Never sent to anybody, never merged into a template:
   *  this is the host's own record of a conversation, which is why there is a
   *  pane for it beside the one place they might otherwise have typed it. */
  createCrmNote: (id: string, body: string) =>
    post<CRMNote>(`/api/host/crm/contacts/${seg(id)}/notes`, {
      body,
    } satisfies CRMNoteRequest),

  /** Deletes a note. There is no edit, deliberately — a note is a dated
   *  observation, so correcting one means deleting it and writing another. */
  deleteCrmNote: (noteId: string) =>
    del<StatusResponse>(`/api/host/crm/notes/${seg(noteId)}`),

  /** The host's WhatsApp templates, as Meta last described them. Served from the
   *  server's cache — `refresh` is the host asking Meta again, which is a real
   *  Graph call against a per-WABA rate limit, so it belongs behind a button and
   *  not in a render. */
  crmTemplates: (refresh = false) =>
    request<CRMTemplatesResponse>(
      `/api/host/crm/templates${refresh ? "?refresh=1" : ""}`,
      fresh,
    ),

  /** Sends one WhatsApp message and returns the message as it was filed in the
   *  thread. Either `body` (only inside the 24-hour window the contact opened) or
   *  `template` + `language` + `params`, never both.
   *
   *  Every rule about whether this is allowed — consent, the window, the
   *  template's approval status — is enforced by the server, which is the only
   *  place it can be. The UI hides what it can to save a round trip; it is not
   *  what makes a send legal. */
  crmSend: (id: string, body: CRMSendRequest) =>
    post<CRMMessage>(`/api/host/crm/contacts/${seg(id)}/send`, body),

  /** Which template each automatic WhatsApp message uses, plus the merge fields a
   *  template's `{{n}}` may be filled with. The fields come from the server rather
   *  than being listed here so the picker cannot offer a token the server would
   *  refuse. */
  crmReminders: () =>
    request<CRMRemindersResponse>("/api/host/crm/reminders", fresh),

  /** Replaces the whole set: a kind sent with an empty `template` is switched off.
   *  Rejects a template that is not approved, or whose parameter count does not
   *  match — checked on save because that is the only moment a host is present to
   *  be told, rather than at 3am the day before a webinar. */
  setCrmReminders: (body: CRMRemindersRequest) =>
    request<CRMRemindersResponse>("/api/host/crm/reminders", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** How many people an audience would reach, and why the rest would not.
   *
   *  Its own call because the count is the decision: a host choosing "everyone who
   *  opted in" is entitled to know whether that is eleven people or four thousand,
   *  and to find out without creating anything. */
  crmAudience: (audience: string, webinarId = "", tagId = "") => {
    const params = new URLSearchParams({ audience });
    if (webinarId) params.set("webinarId", webinarId);
    if (tagId) params.set("tagId", tagId);
    return request<CRMAudienceResponse>(
      `/api/host/crm/audience?${params.toString()}`,
      fresh,
    );
  },

  /** The host's broadcasts, newest first, with their stats. */
  crmBroadcasts: () =>
    request<CRMBroadcastsResponse>("/api/host/crm/broadcasts", fresh),

  /** One broadcast. Polled while it is sending, which is the only time it changes
   *  on its own: the messages leave on the server's sweep, not on a click here. */
  crmBroadcast: (id: string) =>
    request<CRMBroadcast>(`/api/host/crm/broadcasts/${seg(id)}`, fresh),

  /** Creates a broadcast AND schedules it — there is no separate send call and no
   *  draft. The audience is resolved while this request is handled, so the recipient
   *  count that comes back is the number of messages that will go out rather than an
   *  estimate. Nothing is sent inline: the server's outbox sweep does that. */
  createCrmBroadcast: (body: CRMBroadcastRequest) =>
    post<CRMBroadcast>("/api/host/crm/broadcasts", body),

  /** Stops the messages that have not gone out. The sent ones stay sent — there is
   *  no unsend on WhatsApp, and 422 rather than a cheerful success is the answer for
   *  a broadcast that had already finished. */
  cancelCrmBroadcast: (id: string) =>
    post<CRMBroadcast>(`/api/host/crm/broadcasts/${seg(id)}/cancel`),

  /** The host's drip sequences with their steps and counts, plus the triggers and
   *  merge fields the builder may offer — from the server, so the form cannot offer
   *  an entry rule or a token the server would refuse. */
  crmDrips: () => request<CRMDripsResponse>("/api/host/crm/drips", fresh),

  /** One sequence and the people on it. Worth polling while a sequence is running:
   *  steps are queued by the server's 30-second sweep, so positions move on their
   *  own with nobody clicking anything. */
  crmDrip: (id: string) =>
    request<CRMDripResponse>(`/api/host/crm/drips/${seg(id)}`, fresh),

  /** Creates a sequence. `active: false` saves it without starting it — worth using
   *  deliberately, because an active sequence with a `registered` trigger begins
   *  enrolling people the moment the next person signs up. */
  createCrmDrip: (body: CRMDripRequest) =>
    post<CRMDripResponse>("/api/host/crm/drips", body),

  /** Replaces a sequence, steps and all. The people already on it keep their
   *  position, which means editing step 3 of a running sequence changes what the
   *  person sitting on step 2 is about to receive — and inserting a step moves
   *  everybody's place. Pausing (`active: false`) holds them where they are. */
  updateCrmDrip: (id: string, body: CRMDripRequest) =>
    request<CRMDripResponse>(`/api/host/crm/drips/${seg(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Deletes a sequence and forgets who was on it. Pausing is the gentler thing;
   *  messages already sent stay in each contact's conversation either way. */
  deleteCrmDrip: (id: string) => del<void>(`/api/host/crm/drips/${seg(id)}`),

  /** Puts one contact on a sequence by hand. `webinarId` is only needed when a step
   *  mentions the webinar's topic or start time and the sequence itself names no
   *  webinar — there is no registration to infer one from. Nothing is sent by this
   *  call; the first step goes out on the next sweep. */
  enrollCrmDrip: (id: string, body: CRMDripEnrollRequest) =>
    post<CRMDripResponse>(`/api/host/crm/drips/${seg(id)}/enrollments`, body),

  /** Takes somebody off a sequence. The step waiting for them is retired with it,
   *  and the enrollment is kept as "exited" so a later trigger cannot quietly put
   *  the same person back on. */
  removeCrmDripEnrollment: (id: string, enrollmentId: string) =>
    del<CRMDripResponse>(
      `/api/host/crm/drips/${seg(id)}/enrollments/${seg(enrollmentId)}`,
    ),

  /** The host's bots with their flows and conversation counts, plus the triggers,
   *  node kinds and sequences the builder may offer — from the server, for the same
   *  reason as the drip builder's lists: a form that offers a step the server would
   *  refuse is a form that wastes somebody's afternoon. */
  crmBots: () => request<CRMBotsResponse>("/api/host/crm/bots", fresh),

  /** One bot and the conversations it has had. Worth polling while a flow with a
   *  `wait` step is running: sessions wake on the server's 30-second sweep, so
   *  people move through a flow with nobody clicking anything here. */
  crmBot: (id: string) =>
    request<CRMBotResponse>(`/api/host/crm/bots/${seg(id)}`, fresh),

  /** Creates a bot. `active: false` saves the flow without letting it answer
   *  anybody, which is the only safe way to build one: an active bot replies to the
   *  next stranger who messages the host's number, and those replies are billed to
   *  the host's own WhatsApp account. */
  createCrmBot: (body: CRMBotRequest) =>
    post<CRMBotResponse>("/api/host/crm/bots", body),

  /** Replaces a bot, flow and all.
   *
   *  Allowed while people are mid-conversation, and worth understanding: somebody
   *  waiting at a question whose step has been deleted is stopped the next time they
   *  write, and somebody at a step that still exists carries on into the new flow.
   *  Refused (422) for a flow that could not run — a dead link, a loop, a question
   *  with no buttons — and 409 for a second bot set to answer every message. */
  updateCrmBot: (id: string, body: CRMBotRequest) =>
    request<CRMBotResponse>(`/api/host/crm/bots/${seg(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Deletes a bot and forgets the conversations it had. Switching it off
   *  (`active: false`) stops it and keeps them; either way the messages it already
   *  sent stay in each contact's thread, because they were really sent. */
  deleteCrmBot: (id: string) => del<void>(`/api/host/crm/bots/${seg(id)}`),

  /** Takes a conversation over from the bots, or hands it back.
   *
   *  While paused no bot answers this contact — that is what a `handoff` step sets,
   *  and what the host sets from the inbox before typing to somebody themselves.
   *  Handing them back does not resume the flow they were in: their next message
   *  starts one from the top, which is the only honest place to pick up after a
   *  person has been in the conversation. */
  setCrmContactBot: (id: string, body: CRMBotPauseRequest) =>
    request<CRMContact>(`/api/host/crm/contacts/${seg(id)}/bot`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

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
    post<Webinar>(`/api/host/webinars/${seg(slug)}/transfer-host`, {
      identity,
    }),

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

  /** Aggregates for the admin dashboard.
   *
   *  Not derived here from adminUsers and adminWebinars. The account list is
   *  capped, and the webinar list is every full record — both the wrong read
   *  for "how many are live". */
  adminStats: () => request<AdminStats>("/api/admin/stats", fresh),

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

  /** Set a custom max meeting duration for a user in minutes. Pass null to reset to system default. */
  setUserMaxDuration: (userId: string, maxDurationMin: number | null) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/max-duration`, {
      maxDurationMin,
    }),

  /** Configure whether an account's webinars stream to audience attendees via CDN HLS. */
  setCdnBroadcastCapability: (userId: string, canCdnBroadcast: boolean) =>
    patch<Account>(`/api/admin/users/${seg(userId)}/cdn-broadcast`, {
      canCdnBroadcast,
    }),

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

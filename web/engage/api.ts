/* The WhatsApp CRM's API client: /api/host/whatsapp/* and /api/host/crm/*.
 *
 * Its own object rather than more keys on lib/api.ts's `api`, so the webinar client knows
 * nothing about these routes and this module can be dropped without touching it. Same
 * fetch plumbing (lib/http.ts): same cookie, same ApiError. */
import type {
  Account,
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
  StatusResponse,
  WhatsAppCallbackRequest,
  WhatsAppRegisterRequest,
  WhatsAppSignup,
} from "@/lib/api-types";
import { request, post, patch, del, seg, fresh } from "@/lib/http";

export const engageApi = {
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
};

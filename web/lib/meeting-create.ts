import type { Webinar, WebinarInput } from "./api-types.ts";

/* Creating a meeting, and telling one apart from a webinar.
 *
 * A meeting is a webinar row with kind "meeting", and the server decides almost everything
 * about its shape (applyMeetingShape in api/internal/api/meeting.go): standard delivery, no
 * registration, no approval, no passcode, nobody hidden. So the request below does not try to
 * be clever. It sends the same whole record a schedule form would, with each of those fields
 * already set to the one answer a meeting has, so what the host sees before the save is what
 * the server keeps after it — and a reader of this file does not have to go and check that the
 * server would have overruled it.
 *
 * Pure so node can test it: "Start a meeting" is one click with no form behind it, and a
 * request that quietly asks for registration is the kind of mistake only a test sees. */

/** True for a meeting. Accepts anything with a kind, so a list row, a full webinar and a
 *  form state all answer the same way. */
export function isMeetingKind(w: Pick<Webinar, "kind"> | null | undefined): boolean {
  return w?.kind === "meeting";
}

/** The fields every meeting create sends, scheduled or instant. The caller adds the topic,
 *  the time and the status. */
export function meetingInputBase(): Omit<
  WebinarInput,
  "topic" | "startsAt" | "durationMin" | "timeZone" | "status"
> {
  return {
    summary: "",
    description: "",
    track: "",
    kind: "meeting",
    venue: "app",
    delivery: "standard",
    registrationRequired: false,
    approval: "automatic",
    /* The server replaces this with the most any meeting may hold; the number that decides
     * is the host's meeting size, read at join time, so an admin raising it applies to a
     * meeting already on the calendar. */
    attendeeLimit: 10,
    passcode: "",
    agenda: [],
    takeaways: [],
    customQuestions: [],
    panelistEmails: [],
    options: {
      practiceSession: false,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      // A hand in a meeting means "I'd like to speak", as in Zoom (lib/meeting-room.ts).
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
      // Nobody registers for a meeting, so there is nobody to remind.
      emailReminders: false,
      whatsappReminders: false,
      reminders: [],
    },
    controls: {
      // Everyone in a meeting sees everyone else: hiding them would empty the grid.
      hideAttendees: false,
      /* Off, though everyone does arrive muted. A meeting's microphone starts off on the
       * pre-join screen, where the guest can see it and turn it on; muteOnEntry would mute
       * the room's side of them again after they had chosen to speak. */
      muteOnEntry: false,
      allowUnmute: true,
      chatEnabled: true,
      chatDestination: "everyone",
      pollsEnabled: true,
      qaEnabled: true,
      raiseHandEnabled: true,
      reactionsEnabled: true,
      captionsEnabled: false,
      // Server captions are switched on from the room (POST …/captions/server), not at creation.
      serverCaptions: false,
      aiEnabled: false,
      aiAvailable: false,
      locked: false,
      audienceLayout: "auto",
    },
  };
}

/* "Start a meeting": the instant create. The server stamps the start to its own clock and
 * gives a meeting with no length an hour, so the values here are only the type's required
 * fields, not times the host picked. */
export function instantMeetingInput(timeZone: string, now: Date = new Date()): WebinarInput {
  return {
    ...meetingInputBase(),
    topic: "Meeting",
    startsAt: now.toISOString(),
    durationMin: 60,
    timeZone,
    status: "scheduled",
    instant: true,
  };
}

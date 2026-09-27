/* "Your hand is raised" — the requester's side of raise-hand and the stage.
 *
 * lib/hand-toasts.ts is what the host sees about somebody else's hand. This is what that
 * somebody sees about their own: the hand going up, the host lowering it (one hand, or
 * "Lower all hands"), an invitation to the stage, arriving on it, and being moved back
 * to the audience. One card under one key, so each state replaces the last in place —
 * raised → "the host lowered your hand" is the same toast changing, never two stacked.
 *
 * HandTracker skips the viewer's own identity, so the two never overlap: a panelist who
 * raises a hand gets this card and not a "you want to speak" one.
 *
 * Pure, with the clock passed in, like the other toast trackers: what matters here is the
 * order events arrive in and how long things stay, neither of which a live room produces
 * on demand.
 */

export type StageArrival =
  /** An attendee brought onto the stage with camera and microphone. */
  | "stage"
  /** A panelist the host had moved to the audience, given the stage back. */
  | "back"
  /** An audio-only grant: allowed to speak, no camera. */
  | "speak"
  /** Accepted an invite; the grant and the WebRTC connection are still on their way. */
  | "joining";

export type StageInvite = { audioOnly: boolean; recording: boolean };

export type SelfHandView =
  | { phase: "raised" }
  /** Lowered by this person, from the toolbar or the toast. */
  | { phase: "lowered" }
  /** The host lowered this one hand. */
  | { phase: "dismissed" }
  /** The host lowered every hand at once. */
  | { phase: "cleared" }
  | { phase: "invited"; invite: StageInvite }
  | { phase: "stage"; arrival: StageArrival }
  | { phase: "audience" };

export type SelfHandPhase = SelfHandView["phase"];

export const SELF_HAND_KEY = "self-hand";

/** How long each state stays up. Null: until something answers it. */
export const SELF_HAND_MS: Record<SelfHandPhase, number | null> = {
  // Long enough to read and reach for "Lower hand"; the hand itself stays up and the
  // toolbar button keeps saying so.
  raised: 8_000,
  // Their own click — a beat of confirmation, no more.
  lowered: 3_000,
  // Carries "Raise again", so it stays long enough to be pressed.
  dismissed: 10_000,
  cleared: 10_000,
  // A question only this person can answer. The host can withdraw it, which clears it.
  invited: null,
  stage: 7_000,
  audience: 6_000,
};

/** After a pointer or focus leaves a held toast, it gets at least this long again. */
export const SELF_HAND_GRACE_MS = 4_000;

type Shown = { view: SelfHandView; shownAt: number; held: boolean; releasedAt: number | null };

/** States a hand coming down on its own is allowed to replace. An open invite or the
 *  "you're on stage" card is news the hand's bookkeeping must not talk over. */
const HAND_PHASES: ReadonlySet<SelfHandPhase> = new Set(["raised", "lowered", "dismissed", "cleared", "audience"]);

export class SelfHandTracker {
  private up = false;
  private baselined = false;
  private shown: Shown | null = null;

  private show(view: SelfHandView, now: number): void {
    this.shown = { view, shownAt: now, held: false, releasedAt: null };
  }

  private replaceable(): boolean {
    return !this.shown || HAND_PHASES.has(this.shown.view.phase);
  }

  /** A reading of whether this person's hand is up (realtime.myHandRaised). The first
   *  reading is the baseline: a hand that was already up when the room mounted — a
   *  remount, a reconnect — is not news. A hand coming down with no reason reported
   *  first (see `lowered`) is this person's own doing. */
  hand(raised: boolean, now: number): void {
    if (!this.baselined) {
      this.baselined = true;
      this.up = raised;
      return;
    }
    if (raised === this.up) return;
    this.up = raised;
    if (!this.replaceable()) return;
    this.show({ phase: raised ? "raised" : "lowered" }, now);
  }

  /** The host took this person's hand down. Arrives before the hand reading does (the
   *  packet is handled, then React renders), and sets `up` so that reading is a no-op.
   *
   *  - "dismissed": the one-hand dismissal, always told — it is addressed to this person.
   *  - "cleared": "Lower all hands", told only if this hand was actually up.
   *  - "granted": the stage change announces itself; a lingering "raised" card goes. */
  lowered(reason: "dismissed" | "cleared" | "granted", now: number): void {
    const wasUp = this.up;
    this.up = false;
    this.baselined = true;
    if (reason === "granted") {
      if (this.shown?.view.phase === "raised") this.shown = null;
      return;
    }
    if (reason === "cleared" && !wasUp) return;
    if (!this.replaceable()) return;
    this.show({ phase: reason }, now);
  }

  /** realtime.stageInvite: set while an invite is open, null once answered or withdrawn. */
  invite(invite: StageInvite | null, now: number): void {
    if (invite) {
      const current = this.shown?.view;
      if (
        current?.phase === "invited" &&
        current.invite.audioOnly === invite.audioOnly &&
        current.invite.recording === invite.recording
      ) {
        return;
      }
      this.show({ phase: "invited", invite }, now);
      return;
    }
    if (this.shown?.view.phase === "invited") this.shown = null;
  }

  /** Arrived on the stage — a permission change. */
  stage(arrival: StageArrival, now: number): void {
    this.show({ phase: "stage", arrival }, now);
  }

  /** The invite was accepted and the server said yes. By default "Joining the stage…"
   *  until the grant lands — unless it already has (the permission change can beat the
   *  response), in which case the card already says where they are. A room that is about
   *  to be replaced by the stage (the CDN audience) passes the arrival itself: nothing
   *  after the remount announces it. */
  accepted(now: number, arrival: StageArrival = "joining"): void {
    if (this.shown?.view.phase === "stage") return;
    this.show({ phase: "stage", arrival }, now);
  }

  /** The host moved this person back to the audience. */
  audience(now: number): void {
    this.show({ phase: "audience" }, now);
  }

  /** Pointer or keyboard focus inside the card: its clock stops until it leaves. */
  hold(held: boolean, now: number): void {
    if (!this.shown || this.shown.held === held) return;
    this.shown.held = held;
    if (!held) this.shown.releasedAt = now;
  }

  /** Closed by the person. */
  dismiss(): void {
    this.shown = null;
  }

  /** When `tick` next has something to do, or null. */
  nextDeadline(): number | null {
    const s = this.shown;
    if (!s || s.held) return null;
    const ms = SELF_HAND_MS[s.view.phase];
    if (ms == null) return null;
    const due = s.shownAt + ms;
    return s.releasedAt == null ? due : Math.max(due, s.releasedAt + SELF_HAND_GRACE_MS);
  }

  /** Expires what has run its time. True when something changed. */
  tick(now: number): boolean {
    const due = this.nextDeadline();
    if (due == null || now < due) return false;
    this.shown = null;
    return true;
  }

  view(): SelfHandView | null {
    return this.shown?.view ?? null;
  }
}

// ------------------------------------------------------------------ copy

export type SelfHandText = { title: string; detail: string; tone: "info" | "ok" };

/** The card's words. `recording` is the room's own flag, OR-ed with the invite's. */
export function selfHandText(view: SelfHandView, opts: { canRaise?: boolean; recording?: boolean } = {}): SelfHandText {
  const again = opts.canRaise === false ? "" : " You can raise it again anytime.";
  switch (view.phase) {
    case "raised":
      return { title: "Your hand is raised", detail: "The host will see it.", tone: "info" };
    case "lowered":
      return { title: "You lowered your hand", detail: "Raise it again whenever you'd like to speak.", tone: "info" };
    case "dismissed":
      // The old line was "The host dismissed your request to speak for now." Same meaning,
      // said as what happened to the hand rather than as a verdict on the person.
      return { title: "The host lowered your hand for now", detail: `Thanks for raising it.${again}`, tone: "info" };
    case "cleared":
      return { title: "The host lowered all hands", detail: `Including yours.${again}`, tone: "info" };
    case "invited": {
      const { audioOnly, recording } = view.invite;
      const seen = audioOnly ? "Everyone will be able to hear you." : "Everyone will be able to see and hear you.";
      const rec = recording || opts.recording ? " This session is being recorded." : "";
      return {
        title: audioOnly ? "The host invited you to speak" : "The host invited you on stage",
        detail: `${seen}${rec}`,
        tone: "info",
      };
    }
    case "stage":
      switch (view.arrival) {
        case "joining":
          return { title: "Joining the stage…", detail: "Getting your microphone and camera ready.", tone: "ok" };
        case "speak":
          return { title: "You can speak now", detail: "Unmute your microphone when you're ready.", tone: "ok" };
        case "back":
          return { title: "You're back on stage", detail: "Your microphone and camera controls are below.", tone: "ok" };
        case "stage":
          return { title: "You're on stage", detail: "Your microphone and camera controls are below.", tone: "ok" };
      }
      break;
    case "audience":
      return { title: "You're back in the audience", detail: "The host moved you off the stage.", tone: "info" };
  }
  return { title: "", detail: "", tone: "info" };
}

/** The buttons a card offers. */
export function selfHandActions(
  view: SelfHandView,
  opts: { canRaise?: boolean } = {},
): { lower: boolean; raise: boolean; accept: boolean; decline: boolean; close: boolean } {
  const canRaise = opts.canRaise !== false;
  const none = { lower: false, raise: false, accept: false, decline: false, close: true };
  switch (view.phase) {
    case "raised":
      return { ...none, lower: true };
    case "dismissed":
    case "cleared":
      return { ...none, raise: canRaise };
    case "invited":
      // A decision, not news: answered with one of its two buttons, never closed past.
      return { ...none, accept: true, decline: true, close: false };
    default:
      return none;
  }
}

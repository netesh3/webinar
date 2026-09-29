/* What the room's connection toast should say, and when.
 *
 * Pure so it can be tested: a real drop cannot be produced on demand (see lib/recovery.ts),
 * and everything that matters here is about time — a blip too short to mention, a toast that
 * has to wait before escalating, a "back online" that has to go away on its own.
 *
 * The rules:
 *
 *  - The first connect says nothing by itself. A host or panelist reaching the stage on joining
 *    is confirmed by the room calling `greet()` — "You're connected", the same green card as
 *    "back online", gone after BACK_MS. Once per tracker (per room), so re-reading permissions
 *    after a reconnect, or a panelist returned to the stage, never says it again; attendees
 *    are never greeted. (Before the first connect the room's "Connecting…" banner covers the
 *    wait.)
 *  - An outage is only mentioned once it has lasted SHOW_AFTER_MS. LiveKit resumes most drops
 *    in well under a second, and a toast that flashes up and away reads as something broken.
 *  - Once mentioned, it is closed: the same toast turns into "You're back online" and leaves
 *    after BACK_MS. An outage that was never shown ends silently.
 *  - It escalates to "lost" — assertive, with a Rejoin action — once the outage has run for
 *    LOST_AFTER_MS or the retry ladder is on its final attempt. The ladder is still trying at
 *    that point; the escalation is for the person deciding whether to wait.
 *  - Dismissing it hides it for the rest of that outage, except the escalation to "lost",
 *    which is the one thing still worth interrupting for.
 *
 * No LiveKit import: the room maps its ConnectionState onto LinkState, which keeps this file
 * runnable under plain Node.
 */

export type LinkState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type ConnectionSignal = {
  link: LinkState;
  /** The room's own retry ladder: the attempt in flight, or null when it is not running. */
  recovering: number | null;
  /** How many attempts the ladder makes before giving up. */
  attempts: number;
  /** navigator.onLine said no. Only changes the copy — never whether a toast shows. */
  offline?: boolean;
};

export type ConnectionToastView =
  | { phase: "reconnecting"; attempt: number | null; attempts: number; offline: boolean }
  | { phase: "lost"; attempt: number | null; attempts: number; offline: boolean }
  | { phase: "back" }
  | { phase: "connected" };

export const SHOW_AFTER_MS = 1_000;
export const BACK_MS = 2_500;
export const LOST_AFTER_MS = 12_000;

export type ConnectionToastTiming = {
  showAfterMs: number;
  backMs: number;
  lostAfterMs: number;
};

const DEFAULT_TIMING: ConnectionToastTiming = {
  showAfterMs: SHOW_AFTER_MS,
  backMs: BACK_MS,
  lostAfterMs: LOST_AFTER_MS,
};

export function isHealthy(signal: ConnectionSignal): boolean {
  return signal.link === "connected" && signal.recovering === null;
}

export class ConnectionToastTracker {
  private readonly timing: ConnectionToastTiming;
  private everConnected = false;
  private signal: ConnectionSignal | null = null;
  /** When the current outage began, or null while healthy. */
  private outageSince: number | null = null;
  /** Whether this outage has been put on screen. */
  private shown = false;
  /** Dismissed during this outage: stay hidden unless it escalates. */
  private dismissedPhase: "reconnecting" | "lost" | null = null;
  private backUntil: number | null = null;
  /** What the green card that `backUntil` times says: back after an outage, or the greeting. */
  private settled: "back" | "connected" = "back";
  private greeted = false;
  private greetPending = false;
  private now = 0;

  constructor(timing: Partial<ConnectionToastTiming> = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  update(signal: ConnectionSignal, now: number): void {
    this.signal = signal;
    this.now = now;
    const healthy = isHealthy(signal);

    if (!this.everConnected) {
      // Before the first connect the room's banner is the feedback, including the ladder
      // retrying a first connect that failed. Nothing to close later, either.
      if (healthy) {
        this.everConnected = true;
        if (this.greetPending) this.showGreeting(now);
      }
      return;
    }

    if (healthy) {
      if (this.outageSince !== null) {
        const wasVisible = this.shown && this.dismissedPhase === null;
        this.outageSince = null;
        this.shown = false;
        this.dismissedPhase = null;
        this.backUntil = wasVisible ? now + this.timing.backMs : null;
        this.settled = "back";
      }
      return;
    }

    if (this.outageSince === null) {
      this.outageSince = now;
      this.dismissedPhase = null;
      // A drop while "back online" is still up flips that toast straight back — leaving it
      // saying "back" for another second would be false, and hiding it would flicker.
      this.shown = this.backVisible(now);
      this.backUntil = null;
    }
    this.advance(now);
  }

  tick(now: number): void {
    this.now = now;
    this.advance(now);
    if (this.backUntil !== null && now >= this.backUntil) this.backUntil = null;
  }

  /** The person clicked it away. */
  dismiss(): void {
    const view = this.view();
    if (!view) return;
    if (view.phase === "back" || view.phase === "connected") {
      this.backUntil = null;
      return;
    }
    this.dismissedPhase = view.phase;
  }

  /** A presenter has just reached the stage on joining: say "You're connected", once.
   *  Returns whether it will (or, before the first connect, may) show. Ignored while an outage
   *  is in progress — the outage's own toast is the truth then — and spent either way. */
  greet(now: number): boolean {
    if (this.greeted) return false;
    this.greeted = true;
    this.now = now;
    if (!this.everConnected) {
      // Permissions can land a render before the connection state does: hold it until then.
      this.greetPending = true;
      return true;
    }
    return this.showGreeting(now);
  }

  private showGreeting(now: number): boolean {
    this.greetPending = false;
    if (this.outageSince !== null || !this.signal || !isHealthy(this.signal)) return false;
    this.settled = "connected";
    this.backUntil = now + this.timing.backMs;
    return true;
  }

  view(): ConnectionToastView | null {
    const signal = this.signal;
    if (!signal) return null;

    if (this.outageSince !== null) {
      if (!this.shown) return null;
      const phase = this.isLost(signal, this.now) ? "lost" : "reconnecting";
      if (this.dismissedPhase === "lost") return null;
      if (this.dismissedPhase === "reconnecting" && phase === "reconnecting") return null;
      return {
        phase,
        attempt: signal.recovering,
        attempts: signal.attempts,
        offline: signal.offline ?? false,
      };
    }

    return this.backVisible(this.now) ? { phase: this.settled } : null;
  }

  /** When the view next changes with no new signal, for the caller's timer. */
  nextDeadline(): number | null {
    if (this.outageSince !== null) {
      if (!this.shown) return this.outageSince + this.timing.showAfterMs;
      const lostAt = this.outageSince + this.timing.lostAfterMs;
      return this.now < lostAt ? lostAt : null;
    }
    return this.backUntil;
  }

  private advance(now: number): void {
    if (this.outageSince !== null && !this.shown && now - this.outageSince >= this.timing.showAfterMs) {
      this.shown = true;
    }
  }

  private backVisible(now: number): boolean {
    return this.backUntil !== null && now < this.backUntil;
  }

  private isLost(signal: ConnectionSignal, now: number): boolean {
    if (this.outageSince !== null && now - this.outageSince >= this.timing.lostAfterMs) return true;
    return signal.recovering !== null && signal.recovering >= signal.attempts;
  }
}

/** The words for a view — the card draws these, and the fallback message says them.
 *  `publisher`: whether this person is on the stage, which is what "back" restores. */
export function connectionToastText(
  view: ConnectionToastView,
  publisher = true,
): { title: string; detail: string } {
  switch (view.phase) {
    case "connected":
      // Only a host or panelist reaching the stage is greeted, so this is always stage copy —
      // and must be: `publisher` can still be a render behind when the greeting is raised.
      return {
        title: "You're connected",
        detail: "You're live — everyone can see and hear you.",
      };
    case "back":
      return {
        title: "You're back online",
        detail: publisher ? "Everyone can see and hear you again." : "You're watching live again.",
      };
    case "reconnecting":
      return {
        title: "Reconnecting…",
        detail: view.offline
          ? "You're offline. We'll pick up as soon as your network is back."
          : view.attempt !== null
            ? `Hang tight, trying to get you back · attempt ${view.attempt} of ${view.attempts}`
            : "Hang tight, trying to get you back.",
      };
    case "lost":
      return {
        title: "Connection lost",
        detail: view.offline
          ? "You're offline. Check your Wi-Fi or cable, then rejoin."
          : "Still trying, but rejoining is usually faster.",
      };
  }
}

/* "Show only the shared video to the audience".
 *
 * A coach playing an older recording through Share wants it to feel live: the
 * audience should see that video and nothing else — no current host or panelist
 * cameras, no names, no "Host" chips. The host turns it on (session controls
 * `audienceShareOnly`, optionally `audienceMuteStage`), and every audience
 * browser, the recorder and the broadcast compositor decide from the same two
 * pure functions here what to draw and what to download.
 *
 * Two rules matter more than the rest:
 *
 *   Never a blank screen. The flag only changes anything while a share is
 *   actually on the stage. With nothing shared the audience gets the normal
 *   stage, so a host who leaves the switch on between clips is not presenting
 *   black to the room.
 *
 *   The stage itself is unchanged. Hosts, co-hosts and panelists — anybody who
 *   can present — keep their ordinary view; they get a banner saying what the
 *   audience sees instead. The recorder and the broadcast compositor are the
 *   audience: a recording has to match what was watched.
 *
 * Track sources are compared as strings — the values of livekit-client's
 * Track.Source — so this file has no runtime dependency and the tests run it
 * under plain node.
 */

/** Who is looking. "stage" is anybody who can present; "audience" is everybody
 *  watching, including the recorder and the broadcast compositor. */
export type Viewer = "audience" | "stage";

export type ShareOnlyInput = {
  /** controls.audienceShareOnly */
  shareOnly: boolean;
  /** controls.audienceMuteStage */
  muteStage: boolean;
  /** A screen share (or a shared video file, which is published as one) is on the
   *  stage right now. */
  shareActive: boolean;
  viewer: Viewer;
};

/** The viewer is on the stage when they can present at all, or run the session.
 *  Same inputs as the stage's own `canPresent`, so the two cannot disagree. */
export function viewerOf({
  isHost,
  canPresent,
}: {
  isHost: boolean;
  canPresent: boolean;
}): Viewer {
  return isHost || canPresent ? "stage" : "audience";
}

/** Whether this viewer sees the shared video full-bleed and nothing else. */
export function shareOnlyView(input: ShareOnlyInput): boolean {
  return input.shareOnly && input.shareActive && input.viewer === "audience";
}

/** What this viewer should be subscribed to from the stage. Screen share video
 *  and its audio are never in question: they are the content. */
export type SubscriptionPlan = {
  cameras: boolean;
  microphones: boolean;
};

export const FULL_PLAN: SubscriptionPlan = { cameras: true, microphones: true };

export function subscriptionPlan(input: ShareOnlyInput): SubscriptionPlan {
  if (!shareOnlyView(input)) return FULL_PLAN;
  return { cameras: false, microphones: !input.muteStage };
}

/** Whether a remote track of this source belongs in the plan. Anything that is
 *  not a stage camera or microphone — screen share, screen share audio, or a source
 *  this file does not know — is always wanted. */
export function wantsSource(source: string, plan: SubscriptionPlan): boolean {
  if (source === "camera") return plan.cameras;
  if (source === "microphone") return plan.microphones;
  return true;
}

/** The host's banner, so the stage knows what the room is seeing. */
export function bannerText({
  muteStage,
  shareActive,
}: {
  muteStage: boolean;
  shareActive: boolean;
}): string {
  if (!shareActive) return "Audience sees only the shared video · nothing is shared, so they see the stage";
  return muteStage
    ? "Audience sees only the shared video · stage mics muted for them"
    : "Audience sees only the shared video";
}

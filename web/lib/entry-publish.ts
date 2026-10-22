/* Getting the pre-join screen's microphone and camera onto the stage, and saying so honestly
 * when that does not happen.
 *
 * The bug this exists for: a host's stage kept showing their own pre-join self-view under
 * "Your camera — joining the webinar" for the whole session, while the camera button said the
 * camera was off. Both were telling the truth about different things. The camera was running —
 * the pre-join screen had opened it — but it had never been PUBLISHED: the room published the
 * entry tracks exactly once, swallowed any failure, and never tried again. Production telemetry
 * for one such session shows why the one try was not enough: three connection attempts in 44 s
 * (two dropped by the SFU before connecting) followed by a LiveKit resume, i.e. a publish racing
 * a transport that kept going away. A publish that failed then — or was in flight when the
 * recovery ladder rebuilt the connection, which a fresh session does not carry over — left
 * nothing published and nothing to say so. The stage fell back to the preview because it was
 * empty, and the preview only ever disappears when a published track arrives.
 *
 * So the decisions are made here, where they can be tested without a browser:
 *
 *   - entryPlan: what to do for one source on each (re)connect — publish the track the pre-join
 *     screen opened, open the device the ordinary way, or nothing.
 *   - afterFailure: whether a failed publish is the connection's fault (try again on the next
 *     connect) or a real failure (stop, show it, offer a retry).
 *   - showEntryPreview: the self-view is only ever a stand-in while a publish is genuinely on
 *     its way — never for a camera that failed, and never for a capture that has ended.
 *   - cameraButton: what the camera button shows — the publication, not the device or the wish.
 *
 * No imports, so the test can load this file with Node directly (lib/entry-publish.test.mts).
 */

/** Where the camera the presenter asked for on the pre-join screen has got to. */
export type CameraStartPhase =
  /** Waiting for the connection; nothing has been tried yet in this connection. */
  | "connecting"
  /** publishTrack (or opening the device) is in flight. */
  | "publishing"
  /** A camera publication exists — the stage shows that, not the preview. */
  | "published"
  /** Publishing failed on a working connection. The reason is shown with a retry. */
  | "failed"
  /** No camera was asked for, or the presenter has since taken charge of it themselves. */
  | "off";

export type CameraStart = { phase: CameraStartPhase; error: string | null };

export function initialCameraStart(startCamera: boolean): CameraStart {
  return { phase: startCamera ? "connecting" : "off", error: null };
}

export type EntryAction =
  /** Nothing to do: not wanted, or already published. */
  | "skip"
  /** Publish the track the pre-join screen opened — it is still capturing. */
  | "publish-entry"
  /** Open the device the ordinary way: there is no live entry track to hand over. */
  | "open-device";

/** What one source needs on a (re)connect. */
export function entryPlan(input: {
  /** Still wanted from the pre-join screen, i.e. not yet published or given up on. */
  wanted: boolean;
  /** The room already has a publication for this source (a restore, or the control bar). */
  published: boolean;
  /** The pre-join screen's track for this source exists and its capture is live. */
  entryLive: boolean;
}): EntryAction {
  if (!input.wanted || input.published) return "skip";
  return input.entryLive ? "publish-entry" : "open-device";
}

export type FailureVerdict =
  /** The connection went away under the publish: keep wanting it, try on the next connect. */
  | "retry-on-reconnect"
  /** A real failure on a live connection: stop wanting it, release the device, say so. */
  | "give-up";

/** Why a publish failed decides what happens next. */
export function afterFailure(input: {
  /** The room is connected right now. */
  connected: boolean;
  /** The connection was rebuilt (or dropped) while the publish was in flight. */
  connectionChanged: boolean;
}): FailureVerdict {
  return !input.connected || input.connectionChanged ? "retry-on-reconnect" : "give-up";
}

/** What to tell the presenter when a track that IS capturing could not be sent.
 *
 * Not describeMediaError: that is about opening a device, and it reads LiveKit's
 * "insufficient permissions to publish" as the browser blocking the camera, which sends
 * somebody into their site settings for a problem that is not there. */
export function publishFailureMessage(kind: "camera" | "microphone", detail: string): string {
  const which = kind === "camera" ? "camera" : "microphone";
  const why = detail.trim() ? ` (${detail.trim().replace(/\.$/, "")})` : "";
  return `Your ${which} is working but couldn't be sent to the webinar${why}. Check your connection and try again.`;
}

/** Whether the stage may stand the pre-join self-view in for the presenter's camera. */
export function showEntryPreview(input: {
  phase: CameraStartPhase;
  /** The entry track exists and is still capturing. */
  entryLive: boolean;
}): boolean {
  return input.entryLive && (input.phase === "connecting" || input.phase === "publishing");
}

/** The camera button's state.
 *
 * `on` is the publication — LiveKit's isCameraEnabled, a published and unmuted camera track —
 * and never the device being open (the pre-join capture can be running unpublished) or what the
 * presenter asked for. `busy` while the pre-join camera is on its way, so a press in that window
 * does not open a second camera next to the one being published. */
export function cameraButton(input: {
  published: boolean;
  phase: CameraStartPhase | undefined;
}): { on: boolean; busy: boolean } {
  return { on: input.published, busy: !input.published && input.phase === "publishing" };
}

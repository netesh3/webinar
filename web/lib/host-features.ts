import {
  FeatureCloudRecording,
  FeatureFollowupSend,
  FeatureInstantWebinar,
  FeatureMeetings,
  FeatureRepurpose,
  FeatureSimulive,
} from "./api-types.ts";

/* Which host surfaces an account's switches allow (Admin -> Accounts -> Features).
 *
 * The server sends Account.features with every dependency already applied
 * (types.EffectiveFeatures: a sub-switch is dropped without its parent), and refuses
 * the request anyway (403 feature_off), so this only decides what to SHOW. Pure, so
 * it is tested on its own (host-features.test.mts). */

type WithFeatures = { features?: readonly string[] | null } | null | undefined;

export function hasFeature(account: WithFeatures, key: string): boolean {
  return (account?.features ?? []).includes(key);
}

/** Scheduling a simulive at all: the picker page, "Replay as Simulive" on a recording, the
 *  Results autopilot card and the schedule form's simulive mode. */
export function simuliveAllowed(account: WithFeatures): boolean {
  return hasFeature(account, FeatureSimulive);
}

/** The Simulive card on the Webinars screen. It also needs cloud_recording: an account
 *  that cannot record to the cloud has nothing new to replay and no way to make it. */
export function simuliveCardOffered(account: WithFeatures): boolean {
  return simuliveAllowed(account) && hasFeature(account, FeatureCloudRecording);
}

/** The Meetings tab, "New meeting" and "Meet now". On for every host unless an admin
 *  turned it off. */
export function meetingsOffered(account: WithFeatures): boolean {
  return hasFeature(account, FeatureMeetings);
}

/** "Start a meeting" and the Instant webinar card: going live without scheduling. An admin's
 *  per-host switch (instant_webinar, "Instant meetings/webinars (warm-up)"), off by default,
 *  because the video server is started on demand and needs a few minutes' warning. */
export function instantOffered(account: WithFeatures): boolean {
  return hasFeature(account, FeatureInstantWebinar);
}

/** The Repurpose card in AI insights and the brand voice (repurpose, which needs ai). Off by
 *  default: an admin's per-host switch. */
export function repurposeOffered(account: WithFeatures): boolean {
  return hasFeature(account, FeatureRepurpose);
}

/** Sending the AI follow-up drafts from Results (followup_send, which needs ai). */
export function followupSendOffered(account: WithFeatures): boolean {
  return hasFeature(account, FeatureFollowupSend);
}

"use client";

import { PlanBadge, UpgradeLink } from "../plan-lock";
import { Toggle } from "../controls";
import { useAppConfig, useSession } from "../providers";
import { api } from "@/lib/api";
import { interceptConnectClick } from "@/lib/app-connect";
import { FeatureCaptions, FeatureCloudRecording, FeatureStreamOut, type Webinar } from "@/lib/api-types";
import { CaptionsLanguageSelect } from "../captions-language-select";
import { FormGroup, FormSection } from "./chrome";
import type { FormState, SetForm } from "./form-state";

export function RoomSection({
  form,
  set,
  fields,
  editing,
  webinar,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  webinar: Webinar | null;
}) {
  const config = useAppConfig();
  const { account } = useSession();
  const cloudRecording = (account?.features ?? []).includes(FeatureCloudRecording);
  // Server captions (the caption agent) are Business and up; every plan has device captions.
  const serverCaptions = (account?.features ?? []).includes(FeatureCaptions);
  // Streaming out is Professional and up (2 Nov 2026).
  const streamOut = (account?.features ?? []).includes(FeatureStreamOut);
  /* "Record automatically" is a cloud recording the server starts (api/internal/api/
   * auto_record.go), so it needs the host's cloud recording switch and a site that records
   * on the server. Without them it is shown off and disabled rather than hidden, so a host
   * knows it exists. A simulive plays a recording and is never recorded itself. */
  const autoRecordShown = form.kind !== "simulive";
  const autoRecordReady = cloudRecording && config.recordingMode === "egress";
  const extras = (
    [
      // Not captioned live for a simulive: nobody speaks in it, and it shows the original
      // session's captions (the API drops the option for one).
      ...(form.kind !== "simulive"
        ? ([["captions", "Live captions"]] as const)
        : []),
      // Nor streamed out: a simulive has no mix of the room to send (mix_destinations.go).
      ...(form.kind !== "simulive"
        ? ([["multistream", "Stream to YouTube"]] as const)
        : []),
    ] as const
  );
  return (
    <FormGroup label="In the room">
      <FormSection
        title="How the session starts"
        description="You can change any of these live from the host controls once the webinar is running."
        first
      >
        <div className="grid gap-1 lg:grid-cols-2">
          <Toggle
            checked={form.controls.chatEnabled}
            onChange={(v) =>
              set("controls", { ...form.controls, chatEnabled: v })
            }
            label="Attendee chat"
          />
          <Toggle
            checked={form.controls.qaEnabled}
            onChange={(v) =>
              set("controls", { ...form.controls, qaEnabled: v })
            }
            label="Q&A"
          />
          <Toggle
            checked={form.controls.reactionsEnabled}
            onChange={(v) =>
              set("controls", { ...form.controls, reactionsEnabled: v })
            }
            label="Reactions"
          />
          <Toggle
            checked={form.controls.raiseHandEnabled}
            onChange={(v) =>
              set("controls", { ...form.controls, raiseHandEnabled: v })
            }
            label="Raise hand"
          />
          <Toggle
            checked={form.controls.hideAttendees}
            onChange={(v) =>
              set("controls", { ...form.controls, hideAttendees: v })
            }
            label="Hide attendees from each other"
            description="Attendees see only you and the panelists. Enforced by the media server."
          />
          <Toggle
            checked={form.controls.muteOnEntry}
            onChange={(v) =>
              set("controls", { ...form.controls, muteOnEntry: v })
            }
            label="Mute panelists on entry"
          />
          <Toggle
            checked={form.controls.allowUnmute}
            onChange={(v) =>
              set("controls", { ...form.controls, allowUnmute: v })
            }
            label="Panelists may unmute themselves"
          />
        </div>
      </FormSection>

      <FormSection
        title="Who is on the stage"
        description="Panelists can share their camera and screen."
      >
        <div>
          <label className="label" htmlFor="panelists">
            Panelist emails
          </label>
          <textarea
            id="panelists"
            className="field"
            rows={2}
            placeholder="one@example.com, two@example.com"
            value={form.panelistEmails}
            onChange={(e) => set("panelistEmails", e.target.value)}
          />
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
            Each panelist is emailed their stage link once the webinar is
            scheduled, and told if you move or delete it. They need an account,
            because a publishing token is minted from a signed-in session. An
            address without one is named here, and not saved, until they sign up.
          </p>
          {fields.panelistEmails && (
            <p className="mt-1 text-[12px] font-medium text-live">
              {fields.panelistEmails}
            </p>
          )}
          {editing && webinar && webinar.panelists.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-2">
              Currently on the stage:{" "}
              {webinar.panelists.map((p) => p.name).join(", ")}. Take an address
              out of the box to remove that panelist; you are asked before it
              saves.
            </p>
          )}
        </div>
      </FormSection>

      <FormSection
        title="Recording and extras"
        description="Recording, captions and streaming."
      >
        <div className="grid gap-1 lg:grid-cols-2">
          {autoRecordShown && (
            <Toggle
              checked={autoRecordReady && form.options.autoRecord}
              disabled={!autoRecordReady}
              onChange={(v) => set("options", { ...form.options, autoRecord: v })}
              label={
                autoRecordReady ? (
                  "Record automatically"
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    Record automatically
                    {!cloudRecording && (
                      <>
                        <PlanBadge feature={FeatureCloudRecording} />
                        <UpgradeLink />
                      </>
                    )}
                  </span>
                )
              }
              description={
                autoRecordReady
                  ? "Starts a cloud recording once you're live and someone on the stage has their camera or mic on."
                  : cloudRecording
                    ? "Needs server-side recording, which this site doesn't use."
                    : "Cloud recording is on Professional and up. On your plan, record on your own computer from the room."
              }
            />
          )}
          {extras.map(([key, label]) => (
            <Toggle
              key={key}
              checked={key === "multistream" && !streamOut ? false : Boolean(form.options[key])}
              disabled={key === "multistream" && !streamOut}
              onChange={(v) => set("options", { ...form.options, [key]: v })}
              label={
                key === "multistream" && !streamOut ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {label}
                    <PlanBadge feature={FeatureStreamOut} />
                    <UpgradeLink />
                  </span>
                ) : 
                key === "captions" && !serverCaptions ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {label}
                    <PlanBadge feature={FeatureCaptions} />
                  </span>
                ) : (
                  label
                )
              }
              description={
                key === "multistream" && !streamOut
                  ? "Send the session live to YouTube, LinkedIn, Facebook or Instagram. Professional and up."
                  : key === "captions" && !serverCaptions
                  ? "Device captions on your plan: made in each speaker's browser. AI Live captions are on Business and up."
                  : undefined
              }
            />
          ))}
        </div>
        {/* Next to "Live captions": the language spoken, which the captions are made in
            (a host can change it in the room). Not for a simulive, which is never captioned live. */}
        {form.kind !== "simulive" && (
          <div className="mt-3 max-w-sm">
            <CaptionsLanguageSelect
              value={form.options.captionsLanguage}
              onChange={(code) =>
                set("options", { ...form.options, captionsLanguage: code })
              }
              noun={form.kind === "meeting" ? "meeting" : "webinar"}
              error={fields.captionsLanguage}
            />
          </div>
        )}
        {form.options.multistream && streamOut && (
          <div className="mt-3 grid gap-2">
            {config.youtubeOAuth && account?.youtube?.connected ? (
              <p className="text-[12.5px] text-ink-2">
                Linked channel:{" "}
                <span className="font-medium text-ink">
                  {account.youtube.channelTitle || "YouTube"}
                </span>
                . We create an Unlisted live when you start, and put the watch
                link in Recordings. Paste a Studio key below only if you want a
                different destination.
              </p>
            ) : config.youtubeOAuth ? (
              <p className="text-[12.5px] text-ink-2">
                <a
                  href={api.youtubeConnectURL(
                    typeof window === "undefined"
                      ? "/host/schedule"
                      : window.location.pathname,
                  )}
                  // Inside the desktop or mobile app, the connect runs in the system browser.
                  onClick={(e) => interceptConnectClick(e, e.currentTarget.href)}
                  className="font-medium text-brand hover:underline"
                >
                  Connect YouTube
                </a>{" "}
                to create the live automatically, or paste a stream key from
                Studio.
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[12.5px] font-medium text-ink">
                  YouTube watch link
                </span>
                <input
                  id="watch-url"
                  type="url"
                  value={form.streamWatchUrl}
                  onChange={(e) => set("streamWatchUrl", e.target.value)}
                  placeholder="https://youtu.be/…"
                  className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px]"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[12.5px] font-medium text-ink">
                  Stream key
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={form.streamKey}
                  onChange={(e) => set("streamKey", e.target.value)}
                  placeholder={
                    webinar?.streamKeySaved
                      ? "Already saved — paste a new key to replace"
                      : "From YouTube Studio → Go live"
                  }
                  className="h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[13px]"
                />
              </label>
            </div>
            <p className="text-[12px] text-ink-3">
              We push the same mix attendees see. Set the YouTube live to
              Unlisted or Private if you want it as a recording. The watch link
              shows in the recordings tab after the session.
            </p>
          </div>
        )}
      </FormSection>
    </FormGroup>
  );
}

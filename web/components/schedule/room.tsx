"use client";

import { Toggle } from "../controls";
import { useAppConfig, useSession } from "../providers";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
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
            because a publishing token is minted from a signed-in session —
            addresses without one are skipped.
          </p>
          {fields.panelistEmails && (
            <p className="mt-1 text-[12px] font-medium text-live">
              {fields.panelistEmails}
            </p>
          )}
          {editing && webinar && webinar.panelists.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-2">
              Currently on the stage:{" "}
              {webinar.panelists.map((p) => p.name).join(", ")}. Leave the box
              empty to remove them all.
            </p>
          )}
        </div>
      </FormSection>

      <FormSection
        title="Recording and extras"
        description="Recording, captions and streaming."
      >
        <div className="grid gap-1 lg:grid-cols-2">
          {(
            [
              ["autoRecord", "Record automatically"],
              ["captions", "Live captions"],
              ["multistream", "Stream to YouTube / LinkedIn"],
            ] as const
          ).map(([key, label]) => (
            <Toggle
              key={key}
              checked={Boolean(form.options[key])}
              onChange={(v) => set("options", { ...form.options, [key]: v })}
              label={label}
            />
          ))}
        </div>
        {form.options.multistream && (
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

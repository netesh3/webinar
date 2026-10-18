"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import type { WebinarStreamDestination } from "@/lib/api-types";
import { Modal, Spinner } from "../controls";
import { useToast } from "../providers";
import { Button } from "../ui";
import { useRoomUI } from "./context";

/* Stream this webinar to LinkedIn Live, Instagram Live or Facebook Live — each
 * its own button, beside YouTube.
 *
 * The host pastes the Stream URL and Stream key the platform shows. They are
 * saved on the account (the same destination as the Settings card), so a key
 * that stays the same — Facebook's persistent key — is pasted once; LinkedIn
 * and Instagram usually issue a new key per broadcast, and "Use a new key" is
 * right here for that. While the webinar is live the mix is pushed there from
 * the compositor already encoding it; each platform still wants Go live pressed
 * on its own side.
 *
 * A hook rather than a button for the same reason as useYouTubeStream: the
 * button can sit on the bar or in More, and the dialog stays mounted either way. */

export type StreamPlatform = "linkedin" | "instagram" | "facebook";

type PlatformInfo = {
  name: string;
  /** Where the host finds the key and presses Go live. */
  studio: { name: string; url: string };
  saveHref: string;
  badge: { text: string; className: string };
  steps: ReactNode[];
  note: string;
};

const PLATFORMS: Record<StreamPlatform, PlatformInfo> = {
  linkedin: {
    name: "LinkedIn Live",
    studio: { name: "LinkedIn Live Studio", url: "https://www.linkedin.com/video/golive/manage/" },
    saveHref: "/api/host/integrations/linkedin",
    badge: { text: "in", className: "bg-[#0a66c2]" },
    steps: [
      <>Open your event in Live Studio and click <b>Prepare to go live</b>, then <b>Get URL</b>.</>,
      <>Copy the Stream URL and Stream key and paste them below.</>,
      <>When the preview appears in Live Studio, click <b>Go live</b> there.</>,
    ],
    note: "LinkedIn usually gives a new key for each event.",
  },
  instagram: {
    name: "Instagram Live",
    studio: { name: "Instagram on a computer", url: "https://www.instagram.com/" },
    saveHref: "/api/host/integrations/instagram-live",
    badge: { text: "IG", className: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]" },
    steps: [
      <>On instagram.com, click <b>Create (+) → Live video</b>, add a title and audience, then <b>Next</b>.</>,
      <>Copy the Stream URL and Stream key and paste them below.</>,
      <>When the preview appears on Instagram, click <b>Go live</b> there.</>,
    ],
    note: "Needs a Professional account. The key changes for every Instagram Live; lives can run up to 4 hours. Instagram shows landscape video with bars above and below.",
  },
  facebook: {
    name: "Facebook Live",
    studio: { name: "Facebook Live Producer", url: "https://www.facebook.com/live/producer" },
    saveHref: "/api/host/integrations/facebook-live",
    badge: { text: "f", className: "bg-[#1877f2]" },
    steps: [
      <>In Live Producer, choose where to post and pick <b>Streaming software</b> as the video source.</>,
      <>Copy the Server URL and Stream key and paste them below.</>,
      <>When the preview appears in Live Producer, click <b>Go live</b> there.</>,
    ],
    note: "Turn on “Use a persistent stream key” in Facebook and you only paste it once.",
  },
};

export type PlatformStream = {
  /** Pushing to the platform right now — what the live indicator shows. */
  live: boolean;
  open: () => void;
  dialog: ReactNode;
};

export function usePlatformStream(platform: StreamPlatform): PlatformStream {
  const info = PLATFORMS[platform];
  const { slug, isHost } = useRoomUI();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [li, setLi] = useState<WebinarStreamDestination | null>(null);
  const [editing, setEditing] = useState(false);
  const [streamUrl, setStreamUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  /* Re-read every 30s: "streaming" turns on by itself when the webinar goes
   * live, and nothing else here would notice. */
  useEffect(() => {
    if (!isHost) return;
    let stop = false;
    const load = () =>
      api
        .webinarStreamDestination(slug, platform)
        .then((next) => {
          if (!stop) setLi(next);
        })
        .catch(() => {
          // No access or an older API: the button simply stays idle.
        });
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [isHost, slug, platform]);

  const configured = Boolean(li?.configured);
  const showForm = !configured || editing;

  function close() {
    if (busy) return;
    setOpen(false);
    setEditing(false);
    setStreamUrl("");
    setStreamKey("");
    setFields({});
  }

  async function reload() {
    try {
      setLi(await api.webinarStreamDestination(slug, platform));
    } catch {
      // Keep what is on screen.
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await api.saveStreamKey(info.saveHref, { streamUrl: streamUrl.trim(), streamKey: streamKey.trim() });
      await reload();
      setEditing(false);
      setStreamUrl("");
      setStreamKey("");
      notify(`Saved. Once the preview shows in ${info.studio.name}, press Go live there.`, "ok");
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      else notify(err instanceof Error ? err.message : `Could not save the ${info.name} key.`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!li) return;
    setBusy(true);
    try {
      const next = await api.setWebinarStreamPaused(slug, platform, !li.paused);
      setLi(next);
      notify(next.paused ? `${info.name} paused for this webinar.` : `Streaming to ${info.name} again.`, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not change ${info.name}.`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.integrationCall(info.saveHref, "DELETE");
      await reload();
      notify(`${info.name} key removed. Nothing is sent there now.`, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not remove the ${info.name} key.`, "error");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "h-10 w-full rounded-lg border bg-surface px-3 font-mono text-[13px] outline-none focus:ring-2 focus:ring-brand/40";

  const status = !li
    ? ""
    : li.paused
      ? "Paused for this webinar"
      : li.refused
        ? `${info.name} refused this stream key. Your webinar carries on; paste a new key, or pause and resume to try again.`
        : li.streaming
        ? `Sending to ${info.name} · press Go live there when the preview shows`
        : "Starts sending when the webinar is live";

  const dialog = !isHost ? null : (
    <Modal
      open={open}
      onClose={close}
      title={`Stream to ${info.name}`}
      description={
        showForm
          ? `Paste the Stream URL and Stream key from ${info.studio.name}. We send this webinar there while it is live.`
          : `This webinar is sent to ${info.name} while it is live. It shows once you press Go live in ${info.studio.name}.`
      }
      footer={
        showForm ? (
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => (configured ? setEditing(false) : close())} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={`${platform}-key-form`}
              disabled={busy || !streamUrl.trim() || !streamKey.trim()}
            >
              {busy ? <Spinner className="size-4" /> : "Save and stream"}
            </Button>
          </div>
        ) : (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
              Remove key
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
              Use a new key
            </Button>
            <Button variant="primary" onClick={close} disabled={busy}>
              Done
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-3 py-1">
        {configured && li && (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 p-3">
            <span
              className={`grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white ${info.badge.className}`}
              aria-hidden
            >
              {info.badge.text}
            </span>
            <div className="min-w-0 flex-1">
              <b className="block text-[13px] font-semibold text-ink">{status}</b>
              {li.hint && <span className="block truncate text-[12px] text-ink-3">{li.hint}</span>}
            </div>
            {!showForm && (
              <Button variant="secondary" size="sm" onClick={() => void togglePause()} disabled={busy}>
                {li.paused ? "Resume" : "Pause"}
              </Button>
            )}
          </div>
        )}

        {showForm && (
          <form id={`${platform}-key-form`} onSubmit={save} className="grid gap-3">
            <p className="text-[12.5px] text-ink-2">
              Open{" "}
              <a href={info.studio.url} target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-2 hover:underline">
                {info.studio.name}
              </a>
              :
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
              {info.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <label className="grid gap-1">
              <span className="text-[12.5px] font-medium text-ink">Stream URL</span>
              <input
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={streamUrl}
                onChange={(e) => setStreamUrl(e.target.value)}
                placeholder="rtmps://…"
                aria-invalid={Boolean(fields.streamUrl)}
                className={`${input} ${fields.streamUrl ? "border-live" : "border-line"}`}
              />
              {fields.streamUrl && <small className="text-[12px] text-live">{fields.streamUrl}</small>}
            </label>
            <label className="grid gap-1">
              <span className="text-[12.5px] font-medium text-ink">Stream key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={streamKey}
                onChange={(e) => setStreamKey(e.target.value)}
                placeholder={configured ? "Paste the new key" : "Paste the stream key"}
                aria-invalid={Boolean(fields.streamKey)}
                className={`${input} ${fields.streamKey ? "border-live" : "border-line"}`}
              />
              {fields.streamKey && <small className="text-[12px] text-live">{fields.streamKey}</small>}
            </label>
            <p className="text-[12px] leading-relaxed text-ink-3">
              {info.note} The key is saved to your account and never shown again.
            </p>
          </form>
        )}
      </div>
    </Modal>
  );

  return { live: Boolean(li?.streaming), open: () => setOpen(true), dialog };
}

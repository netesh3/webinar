"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import type { WebinarLinkedIn } from "@/lib/api-types";
import { Modal, Spinner } from "../controls";
import { useToast } from "../providers";
import { Button } from "../ui";
import { useRoomUI } from "./context";

/* Stream this webinar to LinkedIn Live — its own button, beside YouTube.
 *
 * The host pastes the Stream URL and Stream key from LinkedIn Live Studio. They
 * are saved on the account (the same destination as the Settings card), so a
 * coach who keeps the same key does nothing next time; LinkedIn usually issues
 * a new key per event, and "Use a new key" is right here for that. While the
 * webinar is live the mix is pushed to LinkedIn from the compositor already
 * encoding it; LinkedIn still wants Go live pressed in Live Studio.
 *
 * A hook rather than a button for the same reason as useYouTubeStream: the
 * button can sit on the bar or in More, and the dialog stays mounted either way. */

const SAVE_HREF = "/api/host/integrations/linkedin";
const LIVE_STUDIO = "https://www.linkedin.com/video/golive/manage/";

export type LinkedInStream = {
  /** Pushing to LinkedIn right now — what the live indicator shows. */
  live: boolean;
  open: () => void;
  dialog: ReactNode;
};

export function useLinkedInStream(): LinkedInStream {
  const { slug, isHost } = useRoomUI();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [li, setLi] = useState<WebinarLinkedIn | null>(null);
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
        .webinarLinkedIn(slug)
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
  }, [isHost, slug]);

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
      setLi(await api.webinarLinkedIn(slug));
    } catch {
      // Keep what is on screen.
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await api.saveStreamKey(SAVE_HREF, { streamUrl: streamUrl.trim(), streamKey: streamKey.trim() });
      await reload();
      setEditing(false);
      setStreamUrl("");
      setStreamKey("");
      notify("Saved. Once the preview shows in LinkedIn Live Studio, press Go live there.", "ok");
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      else notify(err instanceof Error ? err.message : "Could not save the LinkedIn key.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!li) return;
    setBusy(true);
    try {
      const next = await api.setWebinarLinkedIn(slug, !li.paused);
      setLi(next);
      notify(next.paused ? "LinkedIn paused for this webinar." : "Streaming to LinkedIn again.", "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change LinkedIn.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.integrationCall(SAVE_HREF, "DELETE");
      await reload();
      notify("LinkedIn key removed. Nothing is sent to LinkedIn now.", "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not remove the LinkedIn key.", "error");
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
      : li.streaming
        ? "Sending to LinkedIn · press Go live in Live Studio when the preview shows"
        : "Starts sending when the webinar is live";

  const dialog = !isHost ? null : (
    <Modal
      open={open}
      onClose={close}
      title="Stream to LinkedIn Live"
      description={
        showForm
          ? "Paste the Stream URL and Stream key from LinkedIn Live Studio. We send this webinar there while it is live."
          : "This webinar is sent to LinkedIn while it is live. LinkedIn shows it once you press Go live in Live Studio."
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
              form="linkedin-key-form"
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
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#0a66c2] text-[13px] font-bold text-white"
              aria-hidden
            >
              in
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
          <form id="linkedin-key-form" onSubmit={save} className="grid gap-3">
            <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
              <li>
                In{" "}
                <a href={LIVE_STUDIO} target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-2 hover:underline">
                  LinkedIn Live Studio
                </a>
                , open your event and click <b>Prepare to go live</b>, then <b>Get URL</b>.
              </li>
              <li>Copy the Stream URL and Stream key and paste them below.</li>
              <li>When the preview appears in Live Studio, click <b>Go live</b> there.</li>
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
              LinkedIn usually gives a new key for each event. The key is saved to your account and never shown again.
            </p>
          </form>
        )}
      </div>
    </Modal>
  );

  return { live: Boolean(li?.streaming), open: () => setOpen(true), dialog };
}

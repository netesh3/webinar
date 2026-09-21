"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SetStreamRequest, Webinar } from "@/lib/api-types";
import { Modal, Spinner } from "../controls";
import { YouTubeIcon } from "../icons";
import { useAppConfig, useSession, useToast } from "../providers";
import { Button } from "../ui";
import { useRoomUI } from "./context";

/* Stream this webinar to the host's YouTube account.
 *
 * Prefer the connected channel (OAuth creates the live and the watch URL).
 * Pasting a Studio key is still here for hosts who have not linked, or who
 * want a restreamer that is not YouTube. */

export function StreamButton() {
  const { slug, isHost } = useRoomUI();
  const { notify } = useToast();
  const { account } = useSession();
  const { youtubeOAuth } = useAppConfig();
  const [open, setOpen] = useState(false);
  const [wb, setWb] = useState<Webinar | null>(null);
  const [key, setKey] = useState("");
  const [watch, setWatch] = useState("");
  const [privacy, setPrivacy] = useState<"unlisted" | "private" | "public">("unlisted");
  const [paste, setPaste] = useState(false);
  const [busy, setBusy] = useState(false);

  const connected = Boolean(account?.youtube?.connected);
  const channel = account?.youtube?.channelTitle;

  const load = useCallback(async () => {
    try {
      const next = await api.hostWebinar(slug);
      setWb(next);
      setWatch(next.streamWatchUrl ?? "");
    } catch {
      // The host view is the only source of streamConfigured. Failure here
      // just leaves the button in its idle state.
    }
  }, [slug]);

  useEffect(() => {
    if (!isHost) return;
    void load();
  }, [isHost, load]);

  if (!isHost) return null;

  const configured = Boolean(wb?.streamConfigured);
  // A key from an earlier take in this session is still on file, so going live
  // again does not need one — the placeholder should not imply otherwise.
  const keySaved = Boolean(wb?.streamKeySaved);

  async function savePasted() {
    setBusy(true);
    try {
      const body: SetStreamRequest = { streamKey: key, watchUrl: watch };
      const next = await api.setWebinarStream(slug, body);
      setWb(next);
      setKey("");
      setWatch(next.streamWatchUrl ?? "");
      setOpen(false);
      notify(
        "Streaming to YouTube. The link will be in this webinar's recordings tab when you finish.",
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not start the YouTube stream.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function goLiveOnChannel() {
    setBusy(true);
    try {
      const next = await api.setWebinarStream(slug, { viaYouTube: true, privacy, streamKey: "", watchUrl: "" });
      setWb(next);
      setWatch(next.streamWatchUrl ?? "");
      setOpen(false);
      notify(
        "Live on YouTube. The watch link is in this webinar's recordings tab.",
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not start the YouTube stream.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const next = await api.setWebinarStream(slug, { off: true, streamKey: "", watchUrl: "" });
      setWb(next);
      setKey("");
      setOpen(false);
      notify("Stopped pushing to YouTube. The watch link stays in Recordings.", "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not stop the YouTube stream.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={configured ? "YouTube stream is on" : "Stream to YouTube"}
        aria-pressed={configured}
        title={configured ? "YouTube stream is on — click to change" : "Stream to YouTube"}
        onClick={() => setOpen(true)}
        className={`relative inline-flex h-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 sm:min-w-14 ${
          configured
            ? "bg-live/20 text-live-soft"
            : "text-white/75 hover:bg-white/10 hover:text-white"
        }`}
      >
        <YouTubeIcon className="size-5" />
        <span className="hidden text-[9.5px] leading-none font-medium sm:block">
          {configured ? "On YT" : "YouTube"}
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Stream to YouTube"
        description={
          connected
            ? `We'll create the live on ${channel || "your connected channel"} and push the same mix attendees already see.`
            : "Connect your YouTube channel to create the live automatically, or paste a stream key from YouTube Studio."
        }
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            {configured && (
              <Button variant="ghost" onClick={() => void stop()} disabled={busy}>
                Stop streaming
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {connected && !paste ? (
              <Button variant="primary" onClick={() => void goLiveOnChannel()} disabled={busy}>
                {busy ? <Spinner className="size-4" /> : configured ? "Update live" : "Go live"}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void savePasted()} disabled={busy}>
                {busy ? <Spinner className="size-4" /> : configured ? "Update" : "Go live"}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3 py-1">
          {youtubeOAuth && !connected && (
            <a
              href={api.youtubeConnectURL(typeof window === "undefined" ? "/account" : window.location.pathname)}
              className="inline-flex h-9 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-white"
            >
              Connect YouTube
            </a>
          )}

          {connected && !paste && (
            <label className="grid gap-1">
              <span className="text-[12.5px] font-medium text-ink">Who can watch</span>
              <select
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value as typeof privacy)}
                className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px] outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="unlisted">Unlisted — link only (good as a recording)</option>
                <option value="private">Private — only you</option>
                <option value="public">Public</option>
              </select>
            </label>
          )}

          {(paste || !connected) && (
            <>
              <label className="grid gap-1">
                <span className="text-[12.5px] font-medium text-ink">YouTube watch link</span>
                <input
                  type="url"
                  value={watch}
                  onChange={(e) => setWatch(e.target.value)}
                  placeholder="https://youtu.be/…"
                  className="h-10 rounded-lg border border-line bg-surface px-3 text-[13px] outline-none focus:ring-2 focus:ring-brand/40"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[12.5px] font-medium text-ink">Stream key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={keySaved ? "Already saved — paste a new key to replace" : "xxxx-xxxx-xxxx-xxxx"}
                  className="h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] outline-none focus:ring-2 focus:ring-brand/40"
                />
              </label>
            </>
          )}

          {connected && (
            <button
              type="button"
              className="text-[12px] text-ink-3 underline-offset-2 hover:underline"
              onClick={() => setPaste((v) => !v)}
            >
              {paste ? "Use the connected channel instead" : "Paste a Studio stream key instead"}
            </button>
          )}
        </div>
      </Modal>
    </>
  );
}

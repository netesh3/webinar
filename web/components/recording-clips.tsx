"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmModal, Modal, Select, Spinner, Toggle } from "./controls";
import { CopyIcon, SparklesIcon, TrashIcon } from "./icons";
import { useSession, useToast } from "./providers";
import { RecordingHighlights } from "./recording-highlights";
import { Badge, Button } from "./ui";
import { ApiError, api } from "@/lib/api";
import {
  ClipFormatVertical,
  ClipFormatWide,
  ClipFramingFit,
  ClipHookMaxRunes,
  ClipKindClip,
  ClipKindReel,
  type Clip,
  type ClipRange,
  type ClipsResponse,
  type Recording,
  type Reel,
  type ReelsResponse,
} from "@/lib/api-types";
import {
  CLIP_FORMATS,
  CLIP_FRAMINGS,
  PLATFORM_LABELS,
  clipBadge,
  clipsPending,
  formatLabel,
  postText,
  rangesLength,
  reelProblem,
  sizeText,
  waitingText,
} from "@/lib/clips";
import { clock, highlightsStatusText, lengthText } from "@/lib/highlights";

/** How often clips waiting or being made, and reels being planned, are looked at again. */
const CLIPS_POLL_MS = 10_000;
const REELS_POLL_MS = 5_000;

/** Plays one or more stretches of the recording in the player above, in order. */
export type PlayRanges = (ranges: ClipRange[], onStep?: (index: number) => void) => void;

/** What a clip or reel is made from, as the maker opens with it. */
interface MakerSource {
  kind: string;
  sourceId: string;
  title: string;
  hook: string;
  ranges: ClipRange[];
}

/* Highlights, suggested reels and the clips made from a recording, under the player in the
 * Recording tab (the clips switch). A highlight or a reel opens the maker: formats, framing,
 * captions, the hook title, a preview in the player, then Create. The clips are made on the
 * video server between sessions; the list says where they stand, and once made each can be
 * downloaded and posted with the suggested text for each platform. */
export function RecordingClips({
  slug,
  recording,
  playRanges,
}: {
  slug: string;
  recording: Recording;
  playRanges: PlayRanges;
}) {
  const [maker, setMaker] = useState<MakerSource | null>(null);
  const [clips, setClips] = useState<ClipsResponse | null>(null);
  const [poll, setPoll] = useState(0);
  const pending = clips ? clipsPending(clips.clips) : false;

  useEffect(() => {
    const ctl = new AbortController();
    api
      .recordingClips(slug, recording.id, ctl.signal)
      .then((res) => {
        if (!ctl.signal.aborted) setClips(res);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [slug, recording.id, poll]);

  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPoll((n) => n + 1), CLIPS_POLL_MS);
    return () => clearTimeout(t);
  }, [pending, clips]);

  return (
    <>
      <RecordingHighlights
        slug={slug}
        recording={recording}
        onPreview={(start, end) => playRanges([{ startSec: start, endSec: end }])}
        onMakeClip={(h, start, end) =>
          setMaker({
            kind: ClipKindClip,
            sourceId: h.id,
            title: h.title,
            hook: h.hook || h.title,
            ranges: [{ startSec: start, endSec: end }],
          })
        }
      />
      <SuggestedReels
        slug={slug}
        recording={recording}
        playRanges={playRanges}
        onMake={(r) =>
          setMaker({
            kind: ClipKindReel,
            sourceId: r.id,
            title: r.title,
            hook: r.hook,
            ranges: r.moments.map((m) => ({ startSec: m.startSec, endSec: m.endSec })),
          })
        }
      />
      {clips && (
        <ClipList
          slug={slug}
          recordingId={recording.id}
          data={clips}
          onChange={setClips}
          onReload={() => setPoll((n) => n + 1)}
        />
      )}
      {maker && (
        <ClipMaker
          slug={slug}
          recordingId={recording.id}
          source={maker}
          unavailable={clips && !clips.available ? (clips.reason ?? "Clips can't be made here.") : null}
          playRanges={playRanges}
          onClose={() => setMaker(null)}
          onCreated={(res) => {
            setClips(res);
            setMaker(null);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- suggested reels

function SuggestedReels({
  slug,
  recording,
  playRanges,
  onMake,
}: {
  slug: string;
  recording: Recording;
  playRanges: PlayRanges;
  onMake: (r: Reel) => void;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<ReelsResponse | null>(null);
  const [poll, setPoll] = useState(0);
  const [finding, setFinding] = useState(false);
  // Which reel is playing, and which of its moments.
  const [playing, setPlaying] = useState<{ id: string; index: number } | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api
      .recordingReels(slug, recording.id, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setData(res);
        if (res.status === "processing") timer = setTimeout(() => setPoll((n) => n + 1), REELS_POLL_MS);
      })
      .catch(() => {});
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [slug, recording.id, poll]);

  // Planned only when the host asks (it spends their AI allowance), inside the POST. The reels
  // are planned from the transcript, not from the highlights, so this needs nothing found first.
  const find = async () => {
    setFinding(true);
    try {
      const res = await api.findReels(slug, recording.id);
      setData(res);
      if (res.status === "processing") setPoll((n) => n + 1);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't suggest reels.", "error");
    } finally {
      setFinding(false);
    }
  };

  const state = data ? highlightsStatusText(data.status) : null;
  const reels = data?.reels ?? [];
  const offer = !!state && (state.start || state.retry) && reels.length === 0;
  // Nothing to say when the highlights above already say why (AI off, no transcript…).
  if (data && data.status !== "ready" && data.status !== "processing" && reels.length === 0 && !offer) return null;
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
          Suggested reels{" "}
          <span className="inline-flex items-center gap-1 font-normal normal-case">
            · <SparklesIcon className="size-3 text-brand" /> by AI
          </span>
        </p>
        {data?.status === "ready" && (
          <Button type="button" variant="ghost" size="sm" disabled={finding} onClick={() => void find()}>
            {finding && <Spinner className="size-3.5" />}
            Suggest again
          </Button>
        )}
      </div>
      {!data ? (
        <p className="text-[12.5px] text-ink-3">
          <Spinner className="size-3.5" /> Loading the suggested reels…
        </p>
      ) : data.status === "processing" ? (
        <p className="text-[12.5px] text-ink-3">
          <Spinner className="size-3.5" /> Planning reels from the best short moments…
        </p>
      ) : offer ? (
        <>
          <p className="mb-2 text-[12.5px] text-ink-2">
            {state?.start
              ? "AI picks a few short moments on one theme to stitch into a 30–60 second vertical reel. Uses your AI allowance."
              : data.status === "ai_unavailable"
                ? state?.text
                : "The reels couldn't be suggested. Try again in a minute."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={state?.start ? "primary" : "secondary"}
              size="sm"
              disabled={finding}
              onClick={() => void find()}
            >
              {finding && <Spinner className="size-3.5" />}
              {state?.start ? "Suggest reels" : "Try again"}
            </Button>
            {finding && <span className="text-[12.5px] text-ink-3">Suggesting reels… this takes up to a minute.</span>}
          </div>
        </>
      ) : reels.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          {state?.text ?? "No set of short moments made a good reel in this recording."}
        </p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-ink-3">
            Each stitches a few short moments on one theme into a 30–60 second vertical video. Preview plays them back to
            back, the way the reel cuts them.
          </p>
          <ol className="grid gap-2">
            {reels.map((r) => (
              <li key={r.id} className="rounded-lg border border-line px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[12px] text-ink-3">{lengthText(r.durationSec)}</span>
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{r.title}</span>
                </div>
                {r.hook && <p className="mt-1 text-[12.5px] text-ink-2">Hook: “{r.hook}”</p>}
                {r.why && <p className="mt-1 text-[12.5px] text-ink-2">{r.why}</p>}
                <ol className="mt-1.5 flex flex-wrap gap-1">
                  {r.moments.map((m, i) => {
                    const on = playing?.id === r.id && playing.index === i;
                    return (
                      <li
                        key={`${m.startSec}`}
                        title={m.quote}
                        className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${on ? "bg-brand text-on-brand" : "bg-surface-2 text-ink-2"}`}
                      >
                        {i + 1} · {clock(m.startSec)}–{clock(m.endSec)}
                      </li>
                    );
                  })}
                </ol>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      playRanges(
                        r.moments.map((m) => ({ startSec: m.startSec, endSec: m.endSec })),
                        (index) => setPlaying(index < 0 ? null : { id: r.id, index }),
                      )
                    }
                  >
                    Preview
                  </Button>
                  <Button type="button" size="sm" onClick={() => onMake(r)}>
                    Make this reel
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the maker

function ClipMaker({
  slug,
  recordingId,
  source,
  unavailable,
  playRanges,
  onClose,
  onCreated,
}: {
  slug: string;
  recordingId: string;
  source: MakerSource;
  unavailable: string | null;
  playRanges: PlayRanges;
  onClose: () => void;
  onCreated: (res: ClipsResponse) => void;
}) {
  const { notify } = useToast();
  const reel = source.kind === ClipKindReel;
  const [formats, setFormats] = useState<Set<string>>(new Set([ClipFormatVertical]));
  const [framing, setFraming] = useState(ClipFramingFit);
  const [captions, setCaptions] = useState(true);
  const [hook, setHook] = useState(source.hook.slice(0, ClipHookMaxRunes));
  const [title, setTitle] = useState(source.title);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(-1);
  const problem = reel ? reelProblem(source.ranges) : null;
  const onlyWide = formats.size === 1 && formats.has(ClipFormatWide);

  const toggle = (id: string) =>
    setFormats((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    setBusy(true);
    try {
      const res = await api.createClips(slug, recordingId, {
        kind: source.kind,
        sourceId: source.sourceId,
        title,
        ranges: source.ranges,
        formats: CLIP_FORMATS.map((f) => f.id).filter((id) => formats.has(id)),
        framing,
        captions,
        hook,
      });
      notify(formats.size > 1 ? "Queued, one video per format." : "Queued.", "ok");
      onCreated(res);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't queue it.", "error");
    } finally {
      setBusy(false);
    }
  };

  const length = rangesLength(source.ranges);
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={reel ? "Make a reel" : "Make a clip"}
      description={
        reel
          ? `${source.ranges.length} moments stitched with quick cuts, ${lengthText(length)} in all.`
          : `${clock(source.ranges[0].startSec)}–${clock(source.ranges[0].endSec)}, ${lengthText(length)}.`
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || formats.size === 0 || !!problem || !!unavailable}
            onClick={() => void create()}
          >
            {busy && <Spinner className="size-4" />}
            {formats.size > 1 ? `Create ${formats.size} videos` : "Create"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {unavailable && <p className="text-[13px] text-live">{unavailable}</p>}
        <div>
          <p className="label">What it shows</p>
          <ol className="flex flex-wrap gap-1">
            {source.ranges.map((r, i) => (
              <li
                key={`${r.startSec}`}
                className={`rounded-full px-2 py-0.5 font-mono text-[11.5px] ${step === i ? "bg-brand text-on-brand" : "bg-surface-2 text-ink-2"}`}
              >
                {reel ? `${i + 1} · ` : ""}
                {clock(r.startSec)}–{clock(r.endSec)}
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => playRanges(source.ranges, setStep)}
          >
            Preview in the player
          </Button>
          {problem && <p className="mt-1.5 text-[12px] text-live">{problem}</p>}
        </div>

        <fieldset>
          <legend className="label">Formats</legend>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {CLIP_FORMATS.map((f) => (
              <label
                key={f.id}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${formats.has(f.id) ? "border-brand-line bg-brand-soft" : "border-line"}`}
              >
                <input type="checkbox" className="mt-0.5" checked={formats.has(f.id)} onChange={() => toggle(f.id)} />
                <span>
                  <span className="block text-[13px] font-medium text-ink">{f.label}</span>
                  <span className="block text-[11.5px] text-ink-3">{f.where}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {!onlyWide && (
          <Select
            label="Framing for vertical and square"
            value={framing}
            onChange={setFraming}
            hint={CLIP_FRAMINGS.find((f) => f.id === framing)?.hint}
          >
            {CLIP_FRAMINGS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        )}

        <div>
          <label className="label" htmlFor="clip-hook">
            Hook title
          </label>
          <input
            id="clip-hook"
            className="field"
            value={hook}
            maxLength={ClipHookMaxRunes}
            onChange={(e) => setHook(e.target.value)}
            placeholder="Shown big over the first few seconds"
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Shown big at the top for the first 3 seconds, to make people stop scrolling. Leave it empty for none.
          </p>
        </div>

        <Toggle
          checked={captions}
          onChange={setCaptions}
          label="Captions"
          description="Big captions burned in, a few words at a time, lighting up the word being said. Most people watch with the sound off."
        />

        <div>
          <label className="label" htmlFor="clip-title">
            Name
          </label>
          <input id="clip-title" className="field" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
          <p className="mt-1 text-[11.5px] text-ink-3">For your list and the file name; not shown in the video.</p>
        </div>

        <p className="text-[12px] text-ink-3">
          Videos are made on the video server between sessions and count towards your recording storage. We&apos;ll
          suggest what to post with each, for every platform.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the list

function ClipList({
  slug,
  recordingId,
  data,
  onChange,
  onReload,
}: {
  slug: string;
  recordingId: string;
  data: ClipsResponse;
  onChange: (res: ClipsResponse) => void;
  onReload: () => void;
}) {
  const { notify } = useToast();
  const { account } = useSession();
  const [deleting, setDeleting] = useState<Clip | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);

  const makeNow = async () => {
    setStarting(true);
    try {
      const res = await api.makeClipsNow();
      notify(res.text, "ok");
      onReload();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't start the video server.", "error");
    } finally {
      setStarting(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteClip(slug, recordingId, deleting.id);
      onChange({ ...data, clips: data.clips.filter((c) => c.id !== deleting.id) });
      setDeleting(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't delete it.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (data.clips.length === 0) return null;
  const waiting = waitingText(data.clips, data.server);
  return (
    <div className="border-t border-line px-4 py-3">
      <p className="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Your clips and reels</p>
      {waiting && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-[12.5px] text-ink-2">{waiting}</p>
          {data.canMakeNow && account?.isAdmin && (
            <Button type="button" variant="secondary" size="sm" disabled={starting} onClick={() => void makeNow()}>
              {starting && <Spinner className="size-3.5" />}
              Make it now (admin)
            </Button>
          )}
        </div>
      )}
      <ol className="grid gap-2">
        {data.clips.map((c) => (
          <ClipRow
            key={c.id}
            slug={slug}
            recordingId={recordingId}
            clip={c}
            onDelete={() => setDeleting(c)}
            onChange={onChange}
          />
        ))}
      </ol>
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        busy={busy}
        title="Delete this video?"
        body={
          deleting?.status === "ready"
            ? "The file is deleted for good and frees its space in your storage. The recording stays."
            : "It won't be made. The recording stays."
        }
        confirmLabel="Delete"
      />
    </div>
  );
}

function ClipRow({
  slug,
  recordingId,
  clip: c,
  onDelete,
  onChange,
}: {
  slug: string;
  recordingId: string;
  clip: Clip;
  onDelete: () => void;
  onChange: (res: ClipsResponse) => void;
}) {
  const { notify } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const badge = clipBadge(c);
  const post = c.posts.find((p) => p.platform === open) ?? null;

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        notify(`${what} copied.`, "ok");
      } catch {
        notify("Couldn't reach the clipboard.", "info");
      }
    },
    [notify],
  );

  const rewrite = async () => {
    setRewriting(true);
    try {
      onChange(await api.rewriteClipPosts(slug, recordingId, c.id));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't write it again.", "error");
    } finally {
      setRewriting(false);
    }
  };

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{c.title}</span>
        <span className="text-[12px] text-ink-3">
          {c.kind === ClipKindReel ? "Reel" : "Clip"} · {formatLabel(c.format)} · {lengthText(c.durationSec)}
          {c.captions ? " · captions" : ""}
          {c.status === "ready" && c.sizeBytes > 0 ? ` · ${sizeText(c.sizeBytes)}` : ""}
        </span>
      </div>
      {c.hook && <p className="mt-1 text-[12.5px] text-ink-2">Hook: “{c.hook}”</p>}
      {c.status === "processing" && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full bg-brand transition-all" style={{ width: `${Math.max(4, c.progress)}%` }} />
        </div>
      )}
      {c.status === "failed" && c.error && <p className="mt-1 text-[12.5px] text-live">{c.error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {c.status === "ready" && (
          <a
            href={api.clipFileUrl(slug, recordingId, c.id)}
            download
            className="inline-flex h-8 items-center rounded-lg border border-line-2 px-3 text-[12.5px] font-medium text-ink hover:bg-surface-2"
          >
            Download
          </a>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
          <TrashIcon className="size-3.5" />
          Delete
        </Button>
      </div>

      {c.postStatus === "ready" && c.posts.length > 0 && (
        <div className="mt-2.5">
          <p className="mb-1 text-[12px] font-medium text-ink-2">What to post with it</p>
          <div role="tablist" className="flex flex-wrap gap-1">
            {c.posts.map((p) => (
              <button
                key={p.platform}
                type="button"
                role="tab"
                aria-selected={open === p.platform}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] ${open === p.platform ? "border-brand-line bg-brand-soft text-brand" : "border-line text-ink-2"}`}
                onClick={() => setOpen(open === p.platform ? null : p.platform)}
              >
                {PLATFORM_LABELS[p.platform] ?? p.platform}
              </button>
            ))}
          </div>
          {post && (
            <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2">
              <pre className="font-sans text-[12.5px] whitespace-pre-wrap text-ink">{postText(post)}</pre>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => void copy(postText(post), `${PLATFORM_LABELS[post.platform] ?? "Post"} text`)}
              >
                <CopyIcon className="size-3.5" />
                Copy
              </Button>
            </div>
          )}
        </div>
      )}
      {c.postStatus === "pending" && (
        <p className="mt-2 text-[12px] text-ink-3">
          <Spinner className="size-3" /> Writing what to post with it…
        </p>
      )}
      {c.postStatus === "failed" && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          The post text couldn&apos;t be written.
          <Button type="button" variant="ghost" size="sm" disabled={rewriting} onClick={() => void rewrite()}>
            {rewriting && <Spinner className="size-3" />}
            Write it again
          </Button>
        </p>
      )}
    </li>
  );
}

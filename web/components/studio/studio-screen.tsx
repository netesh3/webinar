"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmModal, Menu, Spinner, useDismiss } from "../controls";
import {
  ClapperIcon,
  CopyIcon,
  DownloadIcon,
  InstagramIcon,
  LinkedInIcon,
  MoreIcon,
  PlayIcon,
  SearchIcon,
  TikTokIcon,
  YouTubeIcon,
} from "../icons";
import { useSession, useToast } from "../providers";
import { RecordingThumb } from "../recordings-tab";
import { Button, ButtonLink, Card, Empty } from "../ui";
import { ApiError, api } from "@/lib/api";
import {
  ClipKindReel,
  ClipPlanNoteMaxRunes,
  ClipPlatformLinkedIn,
  ClipPlatformReels,
  ClipPlatformShorts,
  ClipPlatformTikTok,
  ClipPlatformYouTube,
  type ClipPlanInput,
  type ClipServer,
  type StudioClip,
  type StudioRecording,
} from "@/lib/api-types";
import { PLATFORM_LABELS, postText } from "@/lib/clips";
import { clock } from "@/lib/highlights";
import { clipsOffered } from "@/lib/host-features";
import {
  PLAN_PLATFORMS,
  PLAN_STATUS_LABELS,
  STUDIO_VIEWS,
  STUDIO_VIEW_LABELS,
  aspectClass,
  clipStatus,
  cyclePlan,
  dayKey,
  formatChip,
  parseDay,
  planGroups,
  planOf,
  planProblem,
  platformLabel,
  recordingAction,
  recordingHref,
  recordingStatus,
  studioView,
  type StudioView,
} from "@/lib/studio";

/* The Studio (the clips switch): one place for the host's recordings, the clips and reels
 * made from them, and a light plan of where and when to post each. Three views behind one
 * switch, remembered in ?view=. Everything is made in the session's own Recording tab
 * (components/recording-clips.tsx); this page finds highlights, lists, downloads, copies the
 * post text and plans. Nothing is posted anywhere from here. See api/internal/api/studio.go. */

/** How often a list with something on the way is looked at again. */
const POLL_MS = 10_000;

export function StudioScreen() {
  const { account, status } = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const view = studioView(search.get("view"));
  const setView = (v: StudioView) =>
    router.replace(v === "recordings" ? "/host/studio" : `/host/studio?view=${v}`, { scroll: false });

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }
  if (!account) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Sign in to see your Studio</h1>
        <ButtonLink href="/login?next=/host/studio" className="mt-5">
          Sign in
        </ButtonLink>
      </Card>
    );
  }

  return (
    <div className="max-w-6xl">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-[28px] font-semibold tracking-[-0.02em]">
          <ClapperIcon className="size-6 text-brand" />
          Studio
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-3">
          Turn your recordings into short clips, and plan where they go.
        </p>
      </header>

      {!clipsOffered(account) ? (
        <Empty
          title="Studio isn't switched on for this account"
          hint="The Studio is where highlights, clips and reels from your recordings live. Ask us to switch highlights and clips on for your account."
        />
      ) : (
        <>
          <ViewSwitch value={view} onChange={setView} />
          <div className="mt-6">
            {view === "recordings" && <RecordingsView />}
            {view === "clips" && <ClipsView onFind={() => setView("recordings")} />}
            {view === "plan" && <PlanView onFind={() => setView("clips")} />}
          </div>
        </>
      )}
    </div>
  );
}

function ViewSwitch({ value, onChange }: { value: StudioView; onChange: (v: StudioView) => void }) {
  return (
    <div role="tablist" aria-label="Studio" className="inline-flex rounded-xl bg-surface-2 p-1">
      {STUDIO_VIEWS.map((v) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v)}
            className={`h-10 rounded-lg px-4 text-[13.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:h-9 ${
              on ? "bg-surface text-ink shadow-[0_1px_2px_rgba(19,22,25,0.08)]" : "text-ink-2 hover:text-ink"
            }`}
          >
            {STUDIO_VIEW_LABELS[v]}
          </button>
        );
      })}
    </div>
  );
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function dayText(day: string): string {
  const d = parseDay(day);
  return d ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "";
}

function MoreTrigger() {
  return (
    <span className="grid size-10 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink">
      <MoreIcon className="size-4" />
    </span>
  );
}

function LoadMore({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <div className="mt-8 flex justify-center">
      <Button variant="secondary" disabled={busy} onClick={onClick}>
        {busy && <Spinner className="size-4" />}
        Show more
      </Button>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid place-items-center py-20">
      <Spinner className="size-6 text-ink-3" />
    </div>
  );
}

// ---------------------------------------------------------------- recordings

function RecordingsView() {
  const { notify } = useToast();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<StudioRecording[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [more, setMore] = useState(false);
  const [finding, setFinding] = useState<Set<string>>(new Set());
  const [poll, setPoll] = useState(0);

  // The search, a beat after the typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .studioRecordings({ q: query }, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setRows(res.recordings);
        setNext(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) notify(errorText(err, "Couldn't load your recordings."), "error");
      });
    return () => ctl.abort();
  }, [query, poll, notify]);

  // Highlights being found elsewhere (the Recording tab): look again until they are.
  const busy = rows?.some((r) => r.highlightsStatus === "processing" || r.clipsPending > 0) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setPoll((n) => n + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [busy, rows]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const res = await api.studioRecordings({ q: query, cursor: next });
      setRows((cur) => [...(cur ?? []), ...res.recordings]);
      setNext(res.nextCursor);
    } catch (err) {
      notify(errorText(err, "Couldn't load more."), "error");
    } finally {
      setMore(false);
    }
  };

  const find = async (r: StudioRecording) => {
    setFinding((s) => new Set(s).add(r.id));
    try {
      const res = await api.findHighlights(r.slug, r.id);
      setRows((cur) =>
        (cur ?? []).map((x) =>
          x.id === r.id ? { ...x, highlightsStatus: res.status, highlights: res.highlights.length } : x,
        ),
      );
      if (res.status === "ready") {
        notify(
          res.highlights.length === 0
            ? "No moments stood out in this one."
            : `Found ${res.highlights.length} highlight${res.highlights.length === 1 ? "" : "s"}.`,
          "ok",
        );
      }
    } catch (err) {
      notify(errorText(err, "Couldn't find highlights. Try again in a minute."), "error");
    } finally {
      setFinding((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  return (
    <>
      <label className="relative mb-6 block max-w-sm">
        <span className="sr-only">Search sessions</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sessions"
          className="field h-10 pl-9"
        />
      </label>

      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        query ? (
          <Empty title={`No sessions match “${query}”`} hint="Try another word from the session's title." />
        ) : (
          <Empty
            title="No recordings yet"
            hint="Record a session to start making clips. Its recording shows up here once the session ends."
            action={<ButtonLink href="/host">Go to your webinars</ButtonLink>}
          />
        )
      ) : (
        <>
          <ul className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((r) => (
              <RecordingCard
                key={r.id}
                rec={r}
                finding={finding.has(r.id)}
                onFind={() => void find(r)}
                onOpen={() => router.push(recordingHref(r.slug, r.id))}
              />
            ))}
          </ul>
          {next && <LoadMore busy={more} onClick={() => void loadMore()} />}
        </>
      )}
    </>
  );
}

function RecordingCard({
  rec: r,
  finding,
  onFind,
  onOpen,
}: {
  rec: StudioRecording;
  finding: boolean;
  onFind: () => void;
  onOpen: () => void;
}) {
  const href = recordingHref(r.slug, r.id);
  const action = finding ? "busy" : recordingAction(r);
  const state: { text: string; pending?: boolean; problem?: boolean } =
    action === "busy" ? { text: "This takes up to a minute." } : recordingStatus(r);
  const ready = r.highlightsStatus === "ready";

  return (
    <li className="min-w-0">
      <Link
        href={href}
        aria-label={`Open the recording of ${r.topic}`}
        className="group block overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <RecordingThumb src={api.recordingFileURL(r.slug, r.thumbPartId)} durationMs={r.durationMs} parts={r.takes} />
      </Link>
      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{r.topic}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">{dateText(r.sessionAt)}</p>
          <p
            className={`mt-1.5 flex items-center gap-1.5 text-[12.5px] ${state.problem ? "text-warn" : ready ? "text-ink-2" : "text-ink-3"}`}
          >
            {state.pending && <Spinner className="size-3" />}
            {state.text}
          </p>
        </div>
        <Menu
          label="More"
          trigger={<MoreTrigger />}
          items={[
            { kind: "action", label: "Open recording", onSelect: onOpen },
            ...(ready || action === "retry"
              ? [{ kind: "action" as const, label: "Find highlights again", onSelect: onFind, disabled: finding }]
              : []),
          ]}
        />
      </div>
      <div className="mt-3">
        {action === "find" && (
          <Button onClick={onFind} className="w-full sm:w-auto">
            Find highlights
          </Button>
        )}
        {action === "retry" && (
          <Button variant="secondary" onClick={onFind} className="w-full sm:w-auto">
            Try again
          </Button>
        )}
        {action === "busy" && (
          <Button disabled className="w-full sm:w-auto">
            <Spinner className="size-4" />
            Finding…
          </Button>
        )}
        {action === "make" && (
          <ButtonLink href={href} className="w-full sm:w-auto">
            Make clips
          </ButtonLink>
        )}
        {action === "open" && (
          <ButtonLink href={href} variant="secondary" className="w-full sm:w-auto">
            Open
          </ButtonLink>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- clips

const CLIP_FILTERS = [
  { id: "", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "pending", label: "On the way" },
  { id: "failed", label: "Failed" },
] as const;

/** A paged list of the Studio's clips, looked at again while some are on the way. */
function useStudioClips(status: string, limit?: number) {
  const { notify } = useToast();
  const [items, setItems] = useState<StudioClip[] | null>(null);
  const [server, setServer] = useState<ClipServer | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [more, setMore] = useState(false);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .studioClips({ status, limit }, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setItems(res.clips);
        setServer(res.server.text ? res.server : null);
        setNext(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) notify(errorText(err, "Couldn't load your clips."), "error");
      });
    return () => ctl.abort();
  }, [status, limit, poll, notify]);

  const pending = items?.some((c) => c.clip.status === "queued" || c.clip.status === "processing") ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPoll((n) => n + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [pending, items]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const res = await api.studioClips({ status, limit, cursor: next });
      setItems((cur) => [...(cur ?? []), ...res.clips]);
      setNext(res.nextCursor);
    } catch (err) {
      notify(errorText(err, "Couldn't load more."), "error");
    } finally {
      setMore(false);
    }
  };

  return { items, setItems, server, next, more, loadMore };
}

function ClipsView({ onFind }: { onFind: () => void }) {
  const { notify } = useToast();
  const [filter, setFilter] = useState<string>("");
  const { items, setItems, server, next, more, loadMore } = useStudioClips(filter);
  const [deleting, setDeleting] = useState<StudioClip | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = items?.some((c) => c.clip.status === "queued") ? server?.text : null;

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteClip(deleting.slug, deleting.recordingId, deleting.clip.id);
      setItems((cur) => (cur ?? []).filter((c) => c.clip.id !== deleting.clip.id));
      setDeleting(null);
    } catch (err) {
      notify(errorText(err, "Couldn't delete it."), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-2" role="radiogroup" aria-label="Show">
        {CLIP_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`h-10 rounded-full px-4 text-[13px] transition-colors sm:h-8 sm:px-3 ${
              filter === f.id ? "bg-ink text-surface" : "bg-surface-2 text-ink-2 hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {waiting && <p className="mb-6 max-w-2xl text-[12.5px] text-ink-3">{waiting}</p>}

      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        filter ? (
          <Empty title="Nothing here" hint="No clips in this state right now." />
        ) : (
          <Empty
            title="No clips yet"
            hint="Find highlights in a recording, then make a clip or reel from one. They show up here as they're made."
            action={<Button onClick={onFind}>Go to recordings</Button>}
          />
        )
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-8 min-[480px]:grid-cols-2 lg:grid-cols-4">
            {items.map((c) => (
              <ClipCard key={c.clip.id} item={c} onDelete={() => setDeleting(c)} />
            ))}
          </ul>
          {next && <LoadMore busy={more} onClick={() => void loadMore()} />}
        </>
      )}

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        busy={busy}
        title="Delete this video?"
        body={
          deleting?.clip.status === "ready"
            ? "The file is deleted for good and frees its space in your storage. The recording stays."
            : "It won't be made. The recording stays."
        }
        confirmLabel="Delete"
      />
    </>
  );
}

/** The clip's own frame, inside a fixed-height stage so cards of every format line up. */
function ClipThumb({
  item,
  className = "h-56",
  small = false,
}: {
  item: StudioClip;
  className?: string;
  /** The plan's row thumbnail: no length badge, no spinner. */
  small?: boolean;
}) {
  const c = item.clip;
  const [failed, setFailed] = useState(false);
  const wide = c.format === "16x9";
  return (
    <div className={`grid place-items-center overflow-hidden rounded-xl bg-surface-2 ${className}`}>
      <div
        className={`relative overflow-hidden rounded-md bg-stage ${aspectClass(c.format)} ${wide ? "w-full" : "h-full max-w-full"}`}
      >
        {c.status === "ready" && !failed ? (
          <video
            src={`${api.clipFileUrl(item.slug, item.recordingId, c.id)}#t=1`}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            aria-hidden
            onError={() => setFailed(true)}
            className="pointer-events-none size-full object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center bg-gradient-to-br from-surface-2 to-surface-3">
            {c.status === "processing" || c.status === "queued" ? (
              <Spinner className="size-5 text-ink-3" />
            ) : (
              <PlayIcon className="size-6 text-ink-3" />
            )}
          </div>
        )}
        {c.durationSec > 0 && !small && (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-white tabular-nums">
            {clock(c.durationSec)}
          </span>
        )}
      </div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-ink-2">{children}</span>;
}

function ClipCard({ item, onDelete }: { item: StudioClip; onDelete: () => void }) {
  const c = item.clip;
  const st = clipStatus(c);
  const ready = c.status === "ready";
  const router = useRouter();
  return (
    <li className="min-w-0">
      <ClipThumb item={item} />
      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{c.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Chip>{formatChip(c.format)}</Chip>
            {c.kind === ClipKindReel && <Chip>Reel</Chip>}
          </div>
          <p
            className={`mt-1.5 text-[12.5px] ${st.tone === "live" ? "text-live" : st.tone === "ok" ? "text-ink-2" : "text-ink-3"}`}
          >
            {st.text}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">
            {shortDate(c.createdAt)} · {item.topic}
          </p>
        </div>
        <Menu
          label="More"
          trigger={<MoreTrigger />}
          items={[
            {
              kind: "action",
              label: "Open recording",
              onSelect: () => router.push(recordingHref(item.slug, item.recordingId)),
            },
            { kind: "action", label: "Delete", danger: true, onSelect: onDelete },
          ]}
        />
      </div>
      {ready && (
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={api.clipFileUrl(item.slug, item.recordingId, c.id)}
            download
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-2 px-4 text-[13.5px] font-medium text-ink hover:bg-surface-2"
          >
            <DownloadIcon className="size-4" />
            Download
          </a>
          <CopyPost item={item} />
        </div>
      )}
    </li>
  );
}

/** "Copy post": a small popover with the suggested text for each platform, each with Copy. */
function CopyPost({ item, compact = false }: { item: StudioClip; compact?: boolean }) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);
  const c = item.clip;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied.`, "ok");
    } catch {
      notify("Couldn't reach the clipboard.", "info");
    }
  };

  return (
    <div ref={wrap} className="relative">
      {compact ? (
        <button
          type="button"
          aria-label="Copy post"
          aria-expanded={open}
          title="Copy post"
          onClick={() => setOpen((v) => !v)}
          className="grid size-10 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <CopyIcon className="size-4" />
        </button>
      ) : (
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <CopyIcon className="size-4" />
          Copy post
        </Button>
      )}
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 shadow-xl sm:left-0 sm:right-auto">
          {c.postStatus === "ready" && c.posts.length > 0 ? (
            <ul className="grid max-h-[60vh] gap-3 overflow-y-auto">
              {c.posts.map((p) => (
                <li key={p.platform}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                      <PlatformIcon id={p.platform} />
                      {PLATFORM_LABELS[p.platform] ?? p.platform}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void copy(postText(p), `${PLATFORM_LABELS[p.platform] ?? "Post"} text`)}
                    >
                      Copy
                    </Button>
                  </div>
                  <p className="mt-1 line-clamp-3 text-[12.5px] whitespace-pre-line text-ink-3">{postText(p)}</p>
                </li>
              ))}
            </ul>
          ) : c.postStatus === "pending" ? (
            <p className="text-[12.5px] text-ink-3">
              <Spinner className="size-3" /> Writing what to post with it…
            </p>
          ) : c.postStatus === "off" ? (
            <p className="text-[12.5px] text-ink-3">Suggested post text needs AI, which is off for this session.</p>
          ) : (
            <p className="text-[12.5px] text-ink-3">
              The post text couldn&apos;t be written.{" "}
              <Link href={recordingHref(item.slug, item.recordingId)} className="text-brand underline-offset-2 hover:underline">
                Write it again from the recording
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PlatformIcon({ id, className = "size-3.5" }: { id: string; className?: string }) {
  switch (id) {
    case ClipPlatformReels:
      return <InstagramIcon className={className} />;
    case ClipPlatformShorts:
    case ClipPlatformYouTube:
      return <YouTubeIcon className={className} />;
    case ClipPlatformTikTok:
      return <TikTokIcon className={className} />;
    case ClipPlatformLinkedIn:
      return <LinkedInIcon className={className} />;
  }
  return null;
}

// ---------------------------------------------------------------- the plan

function PlanView({ onFind }: { onFind: () => void }) {
  const { notify } = useToast();
  const { items, setItems, next, more, loadMore } = useStudioClips("ready", 100);
  const [today] = useState(() => new Date());
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (item: StudioClip, plan: ClipPlanInput): Promise<boolean> => {
    setSaving(item.clip.id);
    try {
      const saved = await api.saveClipPlan(item.slug, item.recordingId, item.clip.id, plan);
      setItems((cur) => (cur ?? []).map((x) => (x.clip.id === item.clip.id ? { ...x, plan: saved } : x)));
      return true;
    } catch (err) {
      notify(errorText(err, "Couldn't save the plan."), "error");
      return false;
    } finally {
      setSaving(null);
    }
  };

  const cycle = (item: StudioClip) => {
    const next = cyclePlan(planOf(item.plan));
    if (!next) {
      notify("Pick a date to schedule it.", "info");
      setEditing(item.clip.id);
      return;
    }
    void save(item, next);
  };

  if (items === null) return <Loading />;
  if (items.length === 0) {
    return (
      <Empty
        title="Nothing to plan yet"
        hint="Once a clip is made, plan where and when to post it here."
        action={<Button onClick={onFind}>See your clips</Button>}
      />
    );
  }
  return (
    <>
      <p className="mb-6 max-w-2xl text-[12.5px] text-ink-3">
        Your ready clips, by the week you mean to post them. Tap a status to move it along. Nothing is posted for you.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
        {planGroups(items, today).map((g) => (
          <section key={g.bucket} aria-label={g.label}>
            <h2 className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold text-ink">
              {g.label}
              <span className="font-normal text-ink-3 tabular-nums">{g.items.length}</span>
            </h2>
            <ul className="divide-y divide-line">
              {g.items.map((item) => (
                <PlanRow
                  key={item.clip.id}
                  item={item}
                  editing={editing === item.clip.id}
                  saving={saving === item.clip.id}
                  onEdit={() => setEditing(editing === item.clip.id ? null : item.clip.id)}
                  onClose={() => setEditing(null)}
                  onCycle={() => cycle(item)}
                  onSave={async (plan) => {
                    if (await save(item, plan)) setEditing(null);
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {next && <LoadMore busy={more} onClick={() => void loadMore()} />}
    </>
  );
}

const STATUS_PILL: Record<string, string> = {
  idea: "bg-surface-2 text-ink-2",
  scheduled: "bg-brand-soft text-brand",
  posted: "bg-ok-soft text-ok",
};

function PlanRow({
  item,
  editing,
  saving,
  onEdit,
  onClose,
  onCycle,
  onSave,
}: {
  item: StudioClip;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onClose: () => void;
  onCycle: () => void;
  onSave: (plan: ClipPlanInput) => void | Promise<void>;
}) {
  const c = item.clip;
  const plan = planOf(item.plan);
  const nextLabel = PLAN_STATUS_LABELS[cyclePlan(plan)?.status ?? "scheduled"];
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <ClipThumb item={item} small className="h-14 w-14 shrink-0 rounded-lg p-1" />
        <button
          type="button"
          onClick={onEdit}
          aria-expanded={editing}
          className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <span className="block truncate text-[14px] font-medium text-ink">{c.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
            {plan.plannedOn ? <span className="text-ink-2">{dayText(plan.plannedOn)}</span> : <span>No date</span>}
            {plan.platforms.length > 0 ? (
              <span className="flex items-center gap-1.5" aria-label={plan.platforms.map(platformLabel).join(", ")}>
                {plan.platforms.map((p) => (
                  <span key={p} title={platformLabel(p)}>
                    <PlatformIcon id={p} />
                  </span>
                ))}
              </span>
            ) : null}
            <span className="hidden truncate sm:inline">· {formatChip(c.format)} · From {item.topic}</span>
          </span>
        </button>
        <CopyPost item={item} compact />
        <button
          type="button"
          onClick={onCycle}
          disabled={saving}
          title={`Mark as ${nextLabel}`}
          aria-label={`${PLAN_STATUS_LABELS[plan.status]}. Mark as ${nextLabel}`}
          className={`inline-flex h-10 min-w-[5.5rem] shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-opacity disabled:opacity-60 sm:h-8 ${STATUS_PILL[plan.status] ?? STATUS_PILL.idea}`}
        >
          {saving && <Spinner className="size-3" />}
          {PLAN_STATUS_LABELS[plan.status]}
        </button>
      </div>
      {plan.note && !editing && <p className="mt-1.5 pl-[4.25rem] text-[12.5px] text-ink-3">{plan.note}</p>}
      {editing && <Planner initial={plan} saving={saving} onClose={onClose} onSave={onSave} />}
    </li>
  );
}

/** The inline planner under a row: platforms as chips, a day, a note. */
function Planner({
  initial,
  saving,
  onClose,
  onSave,
}: {
  initial: ClipPlanInput;
  saving: boolean;
  onClose: () => void;
  onSave: (plan: ClipPlanInput) => void | Promise<void>;
}) {
  const [plan, setPlan] = useState<ClipPlanInput>(initial);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(wrap, true, onClose);
  const problem = planProblem(plan);
  const toggle = (id: string) =>
    setPlan((p) => ({
      ...p,
      platforms: p.platforms.includes(id) ? p.platforms.filter((x) => x !== id) : [...p.platforms, id],
    }));

  return (
    <div ref={wrap} className="mt-3 rounded-xl bg-surface-2 p-4 sm:ml-[4.25rem]">
      <div className="grid gap-4">
        <fieldset>
          <legend className="label">Where</legend>
          <div className="flex flex-wrap gap-2">
            {PLAN_PLATFORMS.map((p) => {
              const on = plan.platforms.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(p.id)}
                  className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors sm:h-8 ${
                    on ? "border-brand-line bg-brand-soft text-brand" : "border-line bg-surface text-ink-2 hover:text-ink"
                  }`}
                >
                  <PlatformIcon id={p.id} />
                  {p.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="plan-day">
              When
            </label>
            <input
              id="plan-day"
              type="date"
              className="field h-10 w-44"
              value={plan.plannedOn}
              min={dayKey(new Date(2000, 0, 1))}
              onChange={(e) =>
                setPlan((p) => ({
                  ...p,
                  plannedOn: e.target.value,
                  // A day set on an idea schedules it; clearing it takes it back to an idea.
                  status:
                    e.target.value && p.status === "idea"
                      ? "scheduled"
                      : !e.target.value && p.status === "scheduled"
                        ? "idea"
                        : p.status,
                }))
              }
            />
          </div>
          {plan.plannedOn && (
            <Button variant="ghost" onClick={() => setPlan((p) => ({ ...p, plannedOn: "", status: p.status === "scheduled" ? "idea" : p.status }))}>
              Clear date
            </Button>
          )}
        </div>
        <div>
          <label className="label" htmlFor="plan-note">
            Note <span className="font-normal text-ink-3">(just for you)</span>
          </label>
          <textarea
            id="plan-note"
            className="field min-h-16"
            rows={2}
            maxLength={ClipPlanNoteMaxRunes}
            value={plan.note}
            onChange={(e) => setPlan((p) => ({ ...p, note: e.target.value }))}
            placeholder="e.g. Post after the newsletter goes out"
          />
        </div>
        {problem && <p className="text-[12.5px] text-live">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving || !!problem} onClick={() => void onSave(plan)}>
            {saving && <Spinner className="size-4" />}
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

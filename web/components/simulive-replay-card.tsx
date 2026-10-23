"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ReplayCounts, ReplayItem, ReplayPage, Webinar } from "@/lib/api-types";
import { formatOffset, parseOffset, previewText } from "@/lib/simulive-replay";
import { Spinner } from "./controls";
import { useToast } from "./providers";
import { Badge, Button, Card, SectionTitle } from "./ui";

const KIND_LABEL: Record<string, string> = {
  chat: "Chat",
  question: "Question",
  answer: "Answer",
  poll: "Poll",
  poll_close: "Poll closes",
  reaction: "Reactions",
};

type Filter = "all" | "chat" | "qa" | "polls" | "reactions";

const FILTERS: { id: Filter; label: string; count: (c: ReplayCounts) => number }[] = [
  { id: "all", label: "All", count: (c) => c.all },
  { id: "chat", label: "Chat", count: (c) => c.chat },
  { id: "qa", label: "Q&A", count: (c) => c.qa },
  { id: "polls", label: "Polls & quizzes", count: (c) => c.polls },
  { id: "reactions", label: "Reactions", count: (c) => c.reactions },
];

const PAGE = 50;

/* The host's preview of a simulive's engagement replay (FeatureReplayEngage): the original
 * session's chat, questions, answers, polls and quizzes, and reaction bursts, at the moment
 * each happens in the video — names shortened, contact details removed. Polls and quizzes
 * open and close for the NEW audience at the original's moments; they vote, and see their
 * own results.
 *
 * A long session is thousands of items, so it is read a page at a time (server-side), by
 * filter, search and "jump to" a time in the video. Hide takes one item (a question's answer
 * and a poll's close with it) out of the replay; Hide all takes every item in the filter and
 * search, and Hide page this page. On the Setup tab, so it is there before the session and
 * while it runs. */
export function SimuliveReplayCard({ webinar: w }: { webinar: Webinar }) {
  const { notify } = useToast();
  const [page, setPage] = useState<ReplayPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The switch is the webinar HOST's (a co-host may be looking), so the server says.
  const [off, setOff] = useState(false);
  // An uploaded video has no original session, so there is nothing to replay but the video.
  const [uploaded, setUploaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [jump, setJump] = useState("");
  const [at, setAt] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);

  // The search box settles before it is asked.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(search);
      setCursor(undefined);
      setAt(undefined);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!w.simuliveRecordingId) return;
    let cancelled = false;
    api
      .hostReplayPreview(w.id, { filter, q, at, cursor, limit: PAGE })
      .then((p) => {
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === "feature_off") setOff(true);
        else if (e instanceof ApiError && e.code === "uploaded_video") setUploaded(true);
        else setError(e instanceof ApiError ? e.message : "Could not load the replay.");
      });
    return () => {
      cancelled = true;
    };
  }, [w.id, w.simuliveRecordingId, filter, q, at, cursor, reload]);

  const hide = useCallback(
    async (tag: string, req: Parameters<typeof api.setReplayHidden>[1]) => {
      setBusy(tag);
      try {
        const res = await api.setReplayHidden(w.id, req);
        setPage((p) => (p ? { ...p, counts: res.counts } : p));
        setReload((n) => n + 1);
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "Could not update the replay.", "error");
      } finally {
        setBusy(null);
      }
    },
    [w.id, notify],
  );

  if (off) {
    return (
      <Card className="p-5">
        <SectionTitle>Engagement replay</SectionTitle>
        <p className="text-[12.5px] text-ink-2">
          Replay the original session&apos;s chat, Q&amp;A, polls, quizzes and reactions at the moment they
          happened in the video. Engagement replay isn&apos;t switched on for this account — ask us to turn it on.
        </p>
      </Card>
    );
  }

  if (uploaded) {
    return (
      <Card className="p-5">
        <SectionTitle>Engagement replay</SectionTitle>
        <p className="text-[12.5px] text-ink-2">
          This Simulive plays a video you uploaded, so there&apos;s no original session whose chat, Q&amp;A or
          polls could replay. New attendees still chat and ask questions live, and Auto mode, if it&apos;s on,
          answers from your knowledge.
        </p>
      </Card>
    );
  }

  const pickFilter = (f: Filter) => {
    setFilter(f);
    setCursor(undefined);
    setAt(undefined);
  };
  const doJump = () => {
    const ms = parseOffset(jump);
    if (ms == null) {
      notify("Type a time into the video, like 12:30.", "error");
      return;
    }
    setCursor(undefined);
    setAt(ms);
  };

  const counts = page?.counts;
  const items = page?.items ?? [];
  const pageKeys = [...new Set(items.filter((i) => i.key && !i.hidden).map((i) => i.key as string))];
  const scope = filter === "all" ? "" : (FILTERS.find((f) => f.id === filter)?.label.toLowerCase() ?? "");

  return (
    <Card className="p-5">
      <SectionTitle>Engagement replay</SectionTitle>
      <p className="-mt-1 mb-4 text-[12.5px] text-ink-2">
        The original session&apos;s chat, questions and answers appear at the same moment in the video,
        and its reactions float up again. Polls and quizzes open and close at their original times —
        your new audience votes, and sees its own results. Names are shortened and phone numbers and
        emails removed. Hide anything you don&apos;t want replayed.
      </p>
      {error ? (
        <p className="text-[12.5px] text-live">{error}</p>
      ) : page == null ? (
        <Spinner className="size-5 text-ink-3" />
      ) : counts && counts.all === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          Nothing to replay: the recording&apos;s session had no chat, questions, polls or reactions while it was recording.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => pickFilter(f.id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  filter === f.id ? "border-brand-line bg-brand-soft text-brand" : "border-line text-ink-2 hover:bg-surface-2"
                }`}
              >
                {f.label}
                <span className="tabular-nums text-ink-3">{counts ? f.count(counts) : 0}</span>
              </button>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the replay"
              aria-label="Search the replay"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-surface px-3 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            />
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                doJump();
              }}
            >
              <input
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                placeholder="12:30"
                aria-label="Jump to a time in the video"
                className="h-9 w-20 rounded-lg border border-line-2 bg-surface px-2 text-[13px] tabular-nums text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              />
              <Button type="submit" variant="secondary" size="sm">
                Jump
              </Button>
            </form>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <span>
              {counts ? counts.all - counts.hidden : 0} of {counts?.all ?? 0} items will be replayed
              {page.total > 0 && ` · showing ${page.offset + 1}–${page.offset + items.length} of ${page.total}`}
            </span>
            <span className="ml-auto flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy != null || pageKeys.length === 0}
                onClick={() => void hide("page", { keys: pageKeys, hidden: true })}
              >
                Hide page
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy != null || page.total === 0}
                onClick={() => void hide("all", { all: true, filter, q, hidden: true })}
              >
                Hide all{scope && ` ${scope}`}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy != null || (counts?.hidden ?? 0) === 0}
                onClick={() => void hide("show", { all: true, filter, q, hidden: false })}
              >
                Show all{scope && ` ${scope}`}
              </Button>
            </span>
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg border border-line px-3 py-4 text-[12.5px] text-ink-2">Nothing matches.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {items.map((item) => (
                <ReplayRow key={item.id} item={item} busy={busy === item.key} onToggle={() =>
                  item.key && void hide(item.key, { key: item.key, hidden: !item.hidden })} />
              ))}
            </ul>
          )}
          {(page.prevCursor || page.nextCursor) && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!page.prevCursor && page.offset === 0}
                onClick={() => {
                  setAt(undefined);
                  setCursor(page.prevCursor || "0");
                }}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!page.nextCursor}
                onClick={() => {
                  setAt(undefined);
                  setCursor(page.nextCursor);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ReplayRow({ item, busy, onToggle }: { item: ReplayItem; busy: boolean; onToggle: () => void }) {
  // An answer or a poll's close goes with its question or poll.
  const own = item.kind !== "answer" && item.kind !== "poll_close";
  return (
    <li className={`flex items-start gap-3 px-3 py-2 ${item.hidden ? "opacity-50" : ""}`}>
      <span className="w-14 shrink-0 pt-0.5 text-[11.5px] tabular-nums text-ink-3">{formatOffset(item.atMs)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Badge tone={item.kind === "chat" ? "neutral" : "brand"}>
            {item.kind === "poll" && item.poll?.quiz ? "Quiz" : (KIND_LABEL[item.kind] ?? item.kind)}
          </Badge>
          {item.name && <span className="truncate text-[12px] font-medium text-ink">{item.name}</span>}
          {item.kind === "question" && item.anonymous && <span className="text-[12px] text-ink-3">Anonymous</span>}
        </div>
        <p className="mt-0.5 text-[12.5px] break-words wrap-anywhere text-ink-2">{previewText(item)}</p>
      </div>
      {own && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onToggle}
          aria-label={`${item.hidden ? "Show" : "Hide"} this ${KIND_LABEL[item.kind]?.toLowerCase() ?? "item"}`}
        >
          {item.hidden ? "Show" : "Hide"}
        </Button>
      )}
    </li>
  );
}

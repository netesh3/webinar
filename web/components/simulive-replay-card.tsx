"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ReplayItem, Webinar } from "@/lib/api-types";
import { formatOffset, previewText } from "@/lib/simulive-replay";
import { Spinner } from "./controls";
import { useToast } from "./providers";
import { Badge, Button, Card, SectionTitle } from "./ui";

const KIND_LABEL: Record<string, string> = {
  chat: "Chat",
  question: "Question",
  answer: "Answer",
  poll: "Poll",
  poll_results: "Results",
};

const PAGE = 60;

/* The host's preview of a simulive's engagement replay (FeatureReplayEngage): the original
 * session's chat, questions, answers and polls, at the moment each appears in the video, as
 * the audience will see them — names shortened, contact details removed. Hide takes one item
 * (and a question's answer, a poll's results with it) out of the replay; Show puts it back.
 * Lines moderation removed in the original are not here at all.
 *
 * On the Setup tab, so it is there before the session and while it runs. */
export function SimuliveReplayCard({ webinar: w }: { webinar: Webinar }) {
  const { notify } = useToast();
  const [items, setItems] = useState<ReplayItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The switch is the webinar HOST's (a co-host may be looking), so the server says.
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    if (!w.simuliveRecordingId) return;
    let cancelled = false;
    api
      .hostReplayPreview(w.id)
      .then((tl) => {
        if (!cancelled) setItems(tl.items ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === "feature_off") setOff(true);
        else setError(e instanceof ApiError ? e.message : "Could not load the replay.");
      });
    return () => {
      cancelled = true;
    };
  }, [w.id, w.simuliveRecordingId]);

  if (off) {
    return (
      <Card className="p-5">
        <SectionTitle>Engagement replay</SectionTitle>
        <p className="text-[12.5px] text-ink-2">
          Replay the original session&apos;s chat, Q&amp;A and polls at the moment they happened in the
          video. Engagement replay isn&apos;t switched on for this account — ask us to turn it on.
        </p>
      </Card>
    );
  }

  const toggle = async (item: ReplayItem) => {
    if (!item.key) return;
    setBusy(item.key);
    try {
      const tl = await api.setReplayHidden(w.id, item.key, !item.hidden);
      setItems(tl.items ?? []);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not update the replay.", "error");
    } finally {
      setBusy(null);
    }
  };

  const shown = items?.filter((i) => !i.hidden).length ?? 0;

  return (
    <Card className="p-5">
      <SectionTitle>Engagement replay</SectionTitle>
      <p className="-mt-1 mb-4 text-[12.5px] text-ink-2">
        The original session&apos;s chat, questions, answers and polls appear at the same moment in
        the video. Names are shortened and phone numbers and emails removed. Hide anything you
        don&apos;t want replayed; your audience can still chat and ask live.
      </p>
      {error ? (
        <p className="text-[12.5px] text-live">{error}</p>
      ) : items == null ? (
        <Spinner className="size-5 text-ink-3" />
      ) : items.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          Nothing to replay: the recording&apos;s session had no chat, questions or polls while it was recording.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-ink-3">
            {shown} of {items.length} items will be replayed.
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.slice(0, limit).map((item) => (
              <li
                key={item.id}
                className={`flex items-start gap-3 px-3 py-2 ${item.hidden ? "opacity-50" : ""}`}
              >
                <span className="w-14 shrink-0 pt-0.5 text-[11.5px] tabular-nums text-ink-3">
                  {formatOffset(item.atMs)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={item.kind === "chat" ? "neutral" : "brand"}>{KIND_LABEL[item.kind] ?? item.kind}</Badge>
                    {item.name && <span className="truncate text-[12px] font-medium text-ink">{item.name}</span>}
                    {item.kind === "question" && item.anonymous && (
                      <span className="text-[12px] text-ink-3">Anonymous</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] break-words wrap-anywhere text-ink-2">{previewText(item)}</p>
                </div>
                {/* An answer or a poll's results goes with its question or poll. */}
                {item.kind !== "answer" && item.kind !== "poll_results" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === item.key}
                    onClick={() => void toggle(item)}
                    aria-label={`${item.hidden ? "Show" : "Hide"} this ${KIND_LABEL[item.kind]?.toLowerCase() ?? "item"}`}
                  >
                    {item.hidden ? "Show" : "Hide"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {items.length > limit && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setLimit((n) => n + PAGE)}>
              Show more ({items.length - limit} left)
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

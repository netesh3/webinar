"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { QAClustersResponse } from "@/lib/api-types";
import { useCoalescingReader } from "@/lib/polls";
import { askedLabel, suggestError, type QAItem, type TopQuestion } from "@/lib/qa-clusters";
import type { Question } from "@/lib/realtime";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, SparklesIcon } from "../icons";
import { useToast } from "../providers";

/* The live Q&A assistant's pieces of the host's Q&A panel (qa-panel.tsx): the Top questions
 * strip, a cluster card ("3 people asked this", expandable to the originals) and the private
 * suggested answer. Only ever drawn for the host and co-hosts, while qaAssistOn and the
 * server's enabled hold; see api/internal/api/qa_assist.go. */

// How often the panel re-reads the clusters while it is open. The read is also what lets a
// waiting question's pass run (the server's batching window is 20 s).
const CLUSTERS_POLL_MS = 20_000;

/** The clusters, read on mount, on the room's qa-clusters nudge, and every 20 s. Null until
 *  the first read; null again while `on` is false. */
export function useQAClusters(slug: string, revision: number, on: boolean): QAClustersResponse | null {
  const [data, setData] = useState<QAClustersResponse | null>(null);
  const read = useCallback(async () => {
    try {
      setData(await api.qaClusters(slug));
    } catch {
      /* the plain list stays; the next read tries again */
    }
  }, [slug]);
  const request = useCoalescingReader(read);

  useEffect(() => {
    if (on) request();
  }, [on, request, revision]);

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(request, CLUSTERS_POLL_MS);
    return () => clearInterval(timer);
  }, [on, request]);

  return on ? data : null;
}

/** "AI limit reached": grouping paused at a cap. The list still works. */
export function QALimitNote() {
  return (
    <p className="mb-2.5 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 text-[10.5px] leading-5 text-ink-3">
      <SparklesIcon className="size-3" />
      AI limit reached. Similar questions aren&apos;t being grouped for now.
    </p>
  );
}

export function TopQuestionsStrip({ items, slug, onAnswered }: {
  items: TopQuestion[];
  slug: string;
  onAnswered: (questionIds: string[]) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Top questions" className="mb-3 rounded-xl border border-brand-line/60 bg-brand-soft/30 px-3 py-2.5">
      <p className="flex items-center gap-1.5 pb-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-brand uppercase">
        <SparklesIcon className="size-3.5" />
        Top questions
      </p>
      <ol className="space-y-2">
        {items.map((t, i) => (
          <li key={t.id} className="min-w-0">
            <div className="flex items-start gap-2">
              <span className="w-3 shrink-0 pt-px text-[11px] font-semibold text-ink-3 tabular-nums">{i + 1}</span>
              <p className="min-w-0 flex-1 text-[12.5px] leading-snug break-words text-ink wrap-anywhere">{t.text}</p>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-ink-2 tabular-nums">
                <ArrowUpIcon className="size-3" />
                {t.votes}
              </span>
            </div>
            <div className="pl-5">
              {t.askers > 1 && <p className="text-[10.5px] text-ink-3">{askedLabel(t.askers, t.questionIds.length)}</p>}
              <SuggestAnswer slug={slug} clusterId={t.id} onAnswered={() => onAnswered(t.questionIds)} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ClusterCard({ item, slug, renderQuestion, onAnswered }: {
  item: Extract<QAItem, { kind: "cluster" }>;
  slug: string;
  renderQuestion: (q: Question) => React.ReactNode;
  onAnswered: (questionIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ids = item.questions.map((q) => q.id);
  return (
    <article aria-label={`Grouped question: ${item.canonical}`} className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <header className="flex items-center gap-1.5 text-[10.5px] font-semibold text-brand">
        <SparklesIcon className="size-3.5" />
        {askedLabel(item.askers, item.questions.length)}
      </header>
      <div className="mt-1.5 flex items-start gap-2.5">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed font-medium break-words text-ink wrap-anywhere">
          {item.canonical}
        </p>
        <span
          aria-label={`${item.votes} ${item.votes === 1 ? "vote" : "votes"} in total`}
          className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border border-line-2 px-2.5 text-[12px] font-semibold text-ink-2 tabular-nums"
        >
          <ArrowUpIcon className="size-3.5" />
          {item.votes}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7"
        >
          {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          {open ? "Hide" : "Show"} the {item.questions.length} questions
        </button>
        <button
          type="button"
          onClick={() => onAnswered(ids)}
          title="Mark every question in this group answered"
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 transition-colors outline-none hover:bg-ok-soft hover:text-ok focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7"
        >
          <CheckIcon className="size-3.5" />
          Mark answered
        </button>
      </div>
      <SuggestAnswer slug={slug} clusterId={item.id} onAnswered={() => onAnswered(ids)} />
      {open && <div className="mt-2 space-y-2 border-l-2 border-line pl-2.5">{item.questions.map(renderQuestion)}</div>}
    </article>
  );
}

/** "✨ Suggest an answer": one call, a draft only this host sees, with Copy. Never posted. */
export function SuggestAnswer({ slug, clusterId, onAnswered }: {
  slug: string;
  clusterId: string;
  onAnswered: () => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const suggest = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.suggestQAAnswer(slug, clusterId);
      setDraft(out.answer);
    } catch (err) {
      setError(suggestError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      notify("Answer copied.", "info");
    } catch {
      notify("Couldn't copy. Select the text instead.", "error");
    }
  };

  if (draft === null) {
    return (
      <div className="mt-1">
        <button
          type="button"
          onClick={() => void suggest()}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-brand transition-colors outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 md:min-h-7"
        >
          <SparklesIcon className="size-3.5" />
          {busy ? "Drafting…" : "Suggest an answer"}
        </button>
        {error && <p className="px-2 text-[11px] text-live">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-brand-line/60 bg-brand/[0.04] px-2.5 py-2">
      <p className="flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.04em] text-brand uppercase">
        <SparklesIcon className="size-3" />
        Suggested answer · only you see this
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink wrap-anywhere">{draft}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <DraftAction onClick={() => void copy()}>
          <CopyIcon className="size-3.5" />
          Copy
        </DraftAction>
        <DraftAction onClick={onAnswered}>
          <CheckIcon className="size-3.5" />
          Mark answered
        </DraftAction>
        <DraftAction onClick={() => void suggest()} disabled={busy}>
          <SparklesIcon className="size-3.5" />
          {busy ? "Drafting…" : "Try again"}
        </DraftAction>
        <DraftAction onClick={() => setDraft(null)}>Discard</DraftAction>
      </div>
      {error && <p className="text-[11px] text-live">{error}</p>}
    </div>
  );
}

function DraftAction({ children, onClick, disabled = false }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 md:min-h-7"
    >
      {children}
    </button>
  );
}

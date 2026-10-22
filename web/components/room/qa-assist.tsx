"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { QAClustersResponse, QADraft } from "@/lib/api-types";
import { answerProblem, draftSourceChips, MAX_ANSWER_CHARS } from "@/lib/knowledge";
import { useCoalescingReader } from "@/lib/polls";
import { askedLabel, draftFor, pickDraft, suggestError, type QAItem, type TopQuestion } from "@/lib/qa-clusters";
import type { Question } from "@/lib/realtime";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, SendIcon, SparklesIcon } from "../icons";
import { useToast } from "../providers";

/* The live Q&A assistant's pieces of the host's Q&A panel (qa-panel.tsx): the Top questions
 * strip, a cluster card ("3 people asked this", expandable to the originals) and the draft
 * answer (from the AI knowledge; host team only until a host posts it). Only ever drawn for the
 * host and co-hosts, while qaAssistOn and the server's enabled hold; see
 * api/internal/api/qa_assist.go and qa_drafts.go. */

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

export function TopQuestionsStrip({ items, slug, clusters, onAnswered, onPosted }: {
  items: TopQuestion[];
  slug: string;
  clusters: QAClustersResponse["clusters"];
  onAnswered: (questionIds: string[]) => void;
  onPosted: (questionIds: string[], answer: string) => void;
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
              {draftFor(t.id, clusters) ? (
                // The draft itself is on the question's card in the list, not twice.
                <p className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-brand">
                  <SparklesIcon className="size-3" />
                  Draft answer ready below
                </p>
              ) : (
                <SuggestAnswer
                  slug={slug}
                  clusterId={t.id}
                  onAnswered={() => onAnswered(t.questionIds)}
                  onPosted={onPosted}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ClusterCard({ item, slug, draft, renderQuestion, onAnswered, onPosted }: {
  item: Extract<QAItem, { kind: "cluster" }>;
  slug: string;
  draft?: QADraft;
  renderQuestion: (q: Question) => React.ReactNode;
  onAnswered: (questionIds: string[]) => void;
  onPosted: (questionIds: string[], answer: string) => void;
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
      <SuggestAnswer
        slug={slug}
        clusterId={item.id}
        draft={draft}
        onAnswered={() => onAnswered(ids)}
        onPosted={onPosted}
      />
      {open && <div className="mt-2 space-y-2 border-l-2 border-line pl-2.5">{item.questions.map(renderQuestion)}</div>}
    </article>
  );
}

/** The draft answer under a question or cluster, host team only: the server's draft (written
 *  from the AI knowledge when the question arrived, or by "✨ Suggest an answer"), with where
 *  it came from, Edit, Post answer and Discard. Post is the only way it reaches the audience:
 *  the server records it as the host's answer on each open question, and onPosted sends the
 *  room's usual answer packets. Never posted by itself. */
export function SuggestAnswer({ slug, clusterId, draft, onAnswered, onPosted }: {
  slug: string;
  clusterId: string;
  /** The server's open draft for this cluster, if any. */
  draft?: QADraft;
  onAnswered: () => void;
  onPosted: (questionIds: string[], answer: string) => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState<"suggest" | "post" | "discard" | null>(null);
  const [mine, setMine] = useState<QADraft | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The newer of this host's own suggestion and the server's (a co-host's, or an automatic one).
  const shown = pickDraft(mine, draft, gone);
  const text = editing && shown && editing.id === shown.id ? editing.text : (shown?.answer ?? "");

  const suggest = async () => {
    if (busy) return;
    setBusy("suggest");
    setError(null);
    try {
      const out = await api.suggestQAAnswer(slug, clusterId);
      setMine(out.draft);
      setEditing(null);
    } catch (err) {
      setError(suggestError(err));
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    if (!shown || busy) return;
    const problem = answerProblem(text);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy("post");
    setError(null);
    try {
      const out = await api.postQADraft(slug, shown.id, text.trim());
      setGone(shown.id);
      setEditing(null);
      onPosted(out.questionIds, out.answer);
      notify(out.questionIds.length > 1 ? `Answer posted to ${out.questionIds.length} questions.` : "Answer posted.", "info");
    } catch (err) {
      setError(suggestError(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!shown || busy) return;
    setBusy("discard");
    setError(null);
    try {
      await api.discardQADraft(slug, shown.id);
    } catch {
      /* already gone, or the next read shows it again */
    } finally {
      setGone(shown.id);
      setEditing(null);
      setBusy(null);
    }
  };

  if (!shown) {
    return (
      <div className="mt-1">
        <button
          type="button"
          onClick={() => void suggest()}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-brand transition-colors outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 md:min-h-7"
        >
          <SparklesIcon className="size-3.5" />
          {busy === "suggest" ? "Drafting…" : "Suggest an answer"}
        </button>
        {error && <p className="px-2 text-[11px] text-live">{error}</p>}
      </div>
    );
  }

  const chips = draftSourceChips(shown);
  return (
    <div className="mt-2 rounded-lg border border-brand-line/60 bg-brand/[0.04] px-2.5 py-2">
      <p className="flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.04em] text-brand uppercase">
        <SparklesIcon className="size-3" />
        {shown.auto ? "Drafted for you" : "Suggested answer"} · only hosts see this
      </p>
      {editing && editing.id === shown.id ? (
        <>
          <label className="sr-only" htmlFor={`draft-${shown.id}`}>
            Edit the answer
          </label>
          <textarea
            id={`draft-${shown.id}`}
            className="mt-1 w-full resize-y rounded-md border border-line-2 bg-surface px-2 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            rows={4}
            maxLength={MAX_ANSWER_CHARS}
            value={editing.text}
            onChange={(e) => setEditing({ id: shown.id, text: e.target.value })}
          />
          <p className="text-right text-[10.5px] text-ink-3 tabular-nums">
            {[...editing.text].length}/{MAX_ANSWER_CHARS}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink wrap-anywhere">{text}</p>
      )}
      {(chips.length > 0 || !shown.grounded) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-surface-2 px-2 text-[10.5px] leading-5 text-ink-2">
              {c}
            </span>
          ))}
          {!shown.grounded && (
            <span className="rounded-full bg-warn-soft px-2 text-[10.5px] leading-5 text-ink-2">General answer: check it</span>
          )}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => void post()}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center gap-1 rounded-md bg-brand px-2.5 text-[11.5px] font-medium text-on-brand transition-colors outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 md:min-h-7"
        >
          <SendIcon className="size-3.5" />
          {busy === "post" ? "Posting…" : "Post answer"}
        </button>
        {editing && editing.id === shown.id ? (
          <DraftAction onClick={() => setEditing(null)}>Done</DraftAction>
        ) : (
          <DraftAction onClick={() => setEditing({ id: shown.id, text: shown.answer })}>Edit</DraftAction>
        )}
        <DraftAction onClick={onAnswered}>
          <CheckIcon className="size-3.5" />
          Mark answered
        </DraftAction>
        <DraftAction onClick={() => void suggest()} disabled={busy !== null}>
          <SparklesIcon className="size-3.5" />
          {busy === "suggest" ? "Drafting…" : "Try again"}
        </DraftAction>
        <DraftAction onClick={() => void discard()} disabled={busy !== null}>
          Discard
        </DraftAction>
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

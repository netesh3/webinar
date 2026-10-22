"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { aiLockedOff } from "@/lib/ai-session";
import { clusterIdFor, draftFor, groupOpenQuestions, qaAssistOn, topQuestions } from "@/lib/qa-clusters";
import { answerKind, questionAuthor } from "@/lib/qa-view";
import { assistantSignature } from "@/lib/qa-auto";
import { useToast } from "../providers";
import { Alert } from "../controls";
import { ArrowUpIcon, CheckIcon, EyeOffIcon, PinIcon, SendIcon, SparklesIcon } from "../icons";
import { GlyphAvatar, SenderAvatar } from "../sender-avatar";
import { RoleBadge } from "./chat-badges";
import { useRoomUI } from "./context";
import { ClusterCard, QALimitNote, SuggestAnswer, TopQuestionsStrip, useQAClusters } from "./qa-assist";
import type { Question } from "@/lib/realtime";

const MAX_CHARS = 600;

export function QAPanel() {
  const { slug, realtime, controls, isHost, permissions, me, status } = useRoomUI();
  const { notify } = useToast();
  const [draft, setDraft] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grows with what is typed, up to max-h-28, then scrolls. Collapsed to "auto"
  // first so it shrinks back after a delete or a send.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft]);
  const off = !controls.qaEnabled;
  const visible = realtime.questions.filter((q) => isHost || !q.dismissed);
  const open = visible.filter((q) => !q.answered);
  const done = visible.filter((q) => q.answered);

  // The live Q&A assistant (qa-assist.tsx): host and co-hosts, with the room's AI on. Until
  // the server says enabled, and whenever it does not, the list below is the plain one.
  const qa = useQAClusters(slug, realtime.qaClustersRevision, qaAssistOn(isHost, controls));
  const assist = qa?.enabled ? qa : null;
  const items = assist ? groupOpenQuestions(open, assist.clusters) : null;
  const top = assist ? topQuestions(assist.top, assist.clusters, open) : [];
  const markAnswered = (ids: string[]) => {
    for (const id of ids) void persist(id, { answered: true, answer: "" });
  };
  // A posted draft: the server already stored the answer on each question; this is the
  // room's usual answer packet for each, the same one Send answer sends.
  const posted = (ids: string[], answer: string) => {
    for (const id of ids) void realtime.modQuestion(id, { answered: true, answer });
  };

  async function persist(
    id: string,
    patch: { answered?: boolean; answer?: string; pinned?: boolean; dismissed?: boolean },
  ) {
    await realtime.modQuestion(id, patch);
    try {
      await api.patchQuestion(slug, id, patch);
    } catch {
      /* live packet already went out */
    }
  }

  // A simulive's Auto mode answer taken back (qa_auto.go): the server tells the room.
  async function retract(id: string) {
    try {
      await api.retractAutoAnswer(slug, id);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not retract that answer.", "error");
    }
  }

  async function ask() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setAskError(null);
    try {
      await realtime.askQuestion(text, anonymous);
      setDraft("");
    } catch (err) {
      // Said, not swallowed: a question that silently vanishes is one somebody asks again
      // into a room that never heard it. The draft stays in the box.
      setAskError(err instanceof Error ? err.message : "Your question didn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {off && (
          <div className="mb-3">
            <Alert tone="warn">
              The host has turned Q&amp;A off. Existing questions stay visible.
            </Alert>
          </div>
        )}
        {isHost && aiLockedOff(controls, status) && (
          // Said, so the assistant does not just vanish: see AIToggle.
          <p className="mb-3 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 text-[10.5px] leading-5 text-ink-3">
            <SparklesIcon className="size-3" />
            Q&amp;A assistant off: AI was switched off during this session.
          </p>
        )}

        {visible.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
            No questions yet.
            <br />
            {permissions.canPublish
              ? "Questions from the audience land here."
              : "Ask the first one below."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {assist?.limited && <QALimitNote />}
            {assist && (
              <TopQuestionsStrip
                items={top}
                slug={slug}
                clusters={assist.clusters}
                onAnswered={markAnswered}
                onPosted={posted}
              />
            )}
            {done.length > 0 && open.length > 0 && <SectionLabel title="Open" count={open.length} />}
            {items
              ? items.map((item) =>
                  item.kind === "cluster" ? (
                    <ClusterCard
                      key={item.id}
                      item={item}
                      slug={slug}
                      draft={draftFor(item.id, assist?.clusters ?? [])}
                      onAnswered={markAnswered}
                      onPosted={posted}
                      renderQuestion={(q) => (
                        <QuestionCard
                          key={q.id}
                          question={q}
                          isHost={isHost}
                          myIdentity={me.identity}
                          onUpvote={() => void realtime.upvote(q.id)}
                          onAnswered={(answer) => void persist(q.id, { answered: true, answer })}
                          onPin={() => void persist(q.id, { pinned: !q.pinned })}
                          onDismiss={() => void persist(q.id, { dismissed: true })}
                        />
                      )}
                    />
                  ) : (
                    <QuestionCard
                      key={item.question.id}
                      question={item.question}
                      isHost={isHost}
                      myIdentity={me.identity}
                      onUpvote={() => void realtime.upvote(item.question.id)}
                      onAnswered={(answer) => void persist(item.question.id, { answered: true, answer })}
                      onPin={() => void persist(item.question.id, { pinned: !item.question.pinned })}
                      onDismiss={() => void persist(item.question.id, { dismissed: true })}
                      extra={
                        <SuggestAnswer
                          slug={slug}
                          clusterId={clusterIdFor(item.question.id, assist?.clusters ?? [])}
                          draft={draftFor(clusterIdFor(item.question.id, assist?.clusters ?? []), assist?.clusters ?? [])}
                          onAnswered={() => markAnswered([item.question.id])}
                          onPosted={posted}
                        />
                      }
                    />
                  ),
                )
              : open.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    isHost={isHost}
                    myIdentity={me.identity}
                    onUpvote={() => void realtime.upvote(q.id)}
                    onAnswered={(answer) =>
                      void persist(q.id, { answered: true, answer })
                    }
                    onPin={() => void persist(q.id, { pinned: !q.pinned })}
                    onDismiss={() => void persist(q.id, { dismissed: true })}
                  />
                ))}

            {done.length > 0 && (
              <>
                <SectionLabel title="Answered" count={done.length} spaced={open.length > 0} />
                {done.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    isHost={isHost}
                    myIdentity={me.identity}
                    onUpvote={() => void realtime.upvote(q.id)}
                    onAnswered={(answer) =>
                      void persist(q.id, { answered: true, answer })
                    }
                    onPin={() => void persist(q.id, { pinned: !q.pinned })}
                    onDismiss={() => void persist(q.id, { dismissed: true })}
                    onRetract={() => void retract(q.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {!off && (
        <div className="shrink-0 border-t border-line p-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
            className="space-y-2"
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={box}
                className="field max-h-28 min-h-9 flex-1 resize-none py-2 text-[13px]"
                rows={1}
                placeholder="Ask a question…"
                maxLength={MAX_CHARS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask();
                  }
                }}
                aria-label="Your question"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label="Submit question"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-stage transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <SendIcon className="size-4" />
              </button>
            </div>
            {askError && (
              <p role="alert" className="text-[12px] text-live">
                {askError}
              </p>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                className="size-3.5 accent-brand"
                checked={anonymous}
                onChange={(e) => setAnonymous(e.target.checked)}
              />
              Ask anonymously
            </label>
          </form>
        </div>
      )}
    </div>
  );
}

function SectionLabel({
  title,
  count,
  spaced = false,
}: {
  title: string;
  count: number;
  spaced?: boolean;
}) {
  return (
    <p
      className={`flex items-center gap-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase ${
        spaced ? "pt-3" : ""
      }`}
    >
      {title}
      <span className="rounded-full bg-surface-2 px-1.5 text-[10px] leading-4 tracking-normal text-ink-2 tabular-nums">
        {count}
      </span>
    </p>
  );
}

function QuestionCard({
  question: q,
  isHost: hostView,
  myIdentity,
  onUpvote,
  onAnswered,
  onPin,
  onDismiss,
  onRetract,
  extra,
}: {
  question: Question;
  isHost: boolean;
  myIdentity: string;
  onUpvote: () => void;
  onAnswered: (answer: string) => void;
  onPin: () => void;
  onDismiss: () => void;
  /** Takes an Auto mode assistant's answer back (host side, answered questions only). */
  onRetract?: () => void;
  /** Host-side extras under the actions: the Q&A assistant's Suggest an answer. */
  extra?: React.ReactNode;
}) {
  /* A question replayed from a simulive's original session (lib/simulive-replay.ts) is
   * read-only for everyone: no vote, pin, hide or answer — it was answered (or not) then.
   * The host curates the replay from the webinar's Setup tab instead. Auto mode (answering
   * the new audience's questions) is server-side; see qa_auto.go and lib/qa-auto.ts. */
  const isHost = hostView && !q.replay;
  const [answer, setAnswer] = useState("");
  // Editing the assistant's answer (host side): the edit is posted as the host team's.
  const [editing, setEditing] = useState<string | null>(null);
  const author = questionAuthor(q, myIdentity);
  const answered = answerKind(q);
  const signature = answered === "assistant" ? assistantSignature(q.answerBy) : null;

  return (
    <article
      aria-label={`Question from ${author.label}`}
      className={`rounded-xl border px-3 py-2.5 ${
        q.pinned
          ? "border-brand-line bg-brand-soft/40"
          : q.dismissed
            ? "border-line bg-surface-2/40 opacity-60"
            : answered
              ? "border-line bg-surface-2/50"
              : author.mine
                ? "border-brand-line/60 bg-brand/[0.05]"
                : "border-line bg-surface"
      }`}
    >
      {/* Who asked, and when. An anonymous question gets the same neutral glyph
          for everybody — never initials, and never the colour keyed on the
          asker's identity, which would match their chat avatar. */}
      <header className="flex min-w-0 items-center gap-2">
        {author.kind === "anonymous" ? (
          <GlyphAvatar size="sm" />
        ) : (
          <SenderAvatar
            name={author.name}
            identity={author.identity}
            size="sm"
            ring={author.role !== "attendee"}
          />
        )}
        <span
          className={`truncate text-[12.5px] font-semibold ${
            author.kind === "anonymous" ? "text-ink-2" : "text-ink"
          }`}
        >
          {author.label}
        </span>
        {author.kind === "anonymous" && author.mine && (
          <span className="shrink-0 text-[11px] text-ink-3">(you)</span>
        )}
        {author.kind === "person" && <RoleBadge role={author.role} />}
        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-3">{clock(q.at)}</span>
        {q.pinned && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-brand">
            <PinIcon className="size-3" />
            Pinned
          </span>
        )}
        {q.dismissed && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-ink-3">
            <EyeOffIcon className="size-3" />
            Hidden
          </span>
        )}
      </header>

      <div className="mt-1.5 flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p
            className={`text-[13px] leading-relaxed break-words whitespace-pre-wrap wrap-anywhere ${
              answered ? "text-ink-2" : "text-ink"
            }`}
          >
            {q.text}
          </p>

          {answered === "text" && (
            // No answerer on the data — see qa-view.ts — so the reply is attributed
            // to the stage as a whole rather than to a person it might not be.
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-ok/20 bg-ok-soft/60 px-2.5 py-2">
              <GlyphAvatar size="xs" tone="ok" className="mt-px">
                <CheckIcon className="size-3" />
              </GlyphAvatar>
              <div className="min-w-0">
                <p className="text-[10.5px] font-semibold tracking-[0.04em] text-ok uppercase">
                  Answered by the host team
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed break-words wrap-anywhere text-ink">
                  {q.answer}
                </p>
              </div>
            </div>
          )}
          {answered === "assistant" && (
            // A simulive's Auto mode: signed by the assistant with the sparkle, never by the
            // host — no host name or avatar on it (lib/qa-auto.ts).
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-brand-line bg-brand-soft/50 px-2.5 py-2">
              <GlyphAvatar size="xs" className="mt-px">
                <SparklesIcon className="size-3" />
              </GlyphAvatar>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-brand">{signature}</p>
                {editing == null ? (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed break-words wrap-anywhere text-ink">
                    {q.answer}
                  </p>
                ) : (
                  <form
                    className="mt-1 grid gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const text = editing.trim();
                      if (!text) return;
                      onAnswered(text);
                      setEditing(null);
                    }}
                  >
                    <textarea
                      className="field min-h-16 text-base md:text-[12px]"
                      value={editing}
                      maxLength={600}
                      onChange={(e) => setEditing(e.target.value)}
                      aria-label="Edit the answer"
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="submit"
                        disabled={!editing.trim()}
                        className="min-h-11 rounded-md bg-ok px-2.5 text-[11.5px] font-semibold text-stage hover:bg-ok/85 disabled:opacity-40 md:min-h-7"
                      >
                        Save as your answer
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="min-h-11 rounded-md px-2.5 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2 md:min-h-7"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}
          {answered === "live" && (
            <p className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-ok/25 bg-ok-soft px-2 text-[10.5px] leading-5 font-semibold text-ok">
              <CheckIcon className="size-3" />
              Answered live
            </p>
          )}
        </div>

        {/* The upvote, as a pill: count and arrow together, filled once it is yours. */}
        {!q.replay && (
        <button
          type="button"
          onClick={onUpvote}
          disabled={q.votedByMe}
          aria-pressed={q.votedByMe}
          aria-label={
            q.votedByMe
              ? `You upvoted this · ${q.votes} ${q.votes === 1 ? "vote" : "votes"}`
              : `Upvote this question · ${q.votes} ${q.votes === 1 ? "vote" : "votes"}`
          }
          className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 ${
            q.votedByMe
              ? "border-brand bg-brand text-stage"
              : "border-line-2 text-ink-2 hover:border-brand-line hover:bg-brand-soft hover:text-brand"
          }`}
        >
          <ArrowUpIcon className="size-3.5" />
          {q.votes}
        </button>
        )}
      </div>

      {/* Full card width, under the upvote rather than beside it: a text field
          squeezed next to the pill is what pushed the card off a phone screen. */}
      {isHost && !q.answered && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            // Empty is "Mark answered" below, said on purpose rather than by
            // pressing Enter in a blank box.
            if (answer.trim()) onAnswered(answer.trim());
          }}
        >
          <input
            className="field h-11 w-auto min-w-0 flex-1 text-base md:h-7 md:text-[12px]"
            placeholder="Write an answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            aria-label="Written answer"
          />
          <button
            type="submit"
            disabled={!answer.trim()}
            className="min-h-11 shrink-0 rounded-md bg-ok px-2.5 text-[11.5px] font-semibold text-stage transition-colors hover:bg-ok/85 disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-ok/40 md:min-h-7"
          >
            Send answer
          </button>
        </form>
      )}

      {isHost && (
        <div className="mt-2 flex items-center gap-1 border-t border-line pt-1.5">
          <HostAction onClick={onPin} active={q.pinned}>
            <PinIcon className="size-3.5" />
            {q.pinned ? "Unpin" : "Pin"}
          </HostAction>
          {!q.dismissed && (
            <HostAction onClick={onDismiss}>
              <EyeOffIcon className="size-3.5" />
              Hide
            </HostAction>
          )}
          {answered === "assistant" && (
            <>
              <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-brand">
                <SparklesIcon className="size-3" />
                Auto-answered
              </span>
              {editing == null && (
                <HostAction onClick={() => setEditing(q.answer)} title="Edit the assistant's answer">
                  Edit
                </HostAction>
              )}
              {onRetract && (
                <HostAction onClick={onRetract} title="Take the assistant's answer back: the question is open again">
                  Retract
                </HostAction>
              )}
            </>
          )}
          {!q.answered && (
            <HostAction onClick={() => onAnswered("")} tone="ok" title="Mark as answered">
              <CheckIcon className="size-3.5" />
              Mark answered
            </HostAction>
          )}
        </div>
      )}
      {isHost && !q.answered && extra}
    </article>
  );
}

function HostAction({
  children,
  onClick,
  active = false,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: "neutral" | "ok";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 ${
        active
          ? "text-brand hover:bg-brand-soft"
          : tone === "ok"
            ? "text-ink-2 hover:bg-ok-soft hover:text-ok"
            : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { answerKind, questionAuthor } from "@/lib/qa-view";
import { Alert } from "../controls";
import { ArrowUpIcon, CheckIcon, EyeOffIcon, PinIcon, SendIcon } from "../icons";
import { GlyphAvatar, SenderAvatar } from "../sender-avatar";
import { RoleBadge } from "./chat-badges";
import { useRoomUI } from "./context";
import type { Question } from "@/lib/realtime";

const MAX_CHARS = 600;

export function QAPanel() {
  const { slug, realtime, controls, isHost, permissions, me } = useRoomUI();
  const [draft, setDraft] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);

  const off = !controls.qaEnabled;
  const visible = realtime.questions.filter((q) => isHost || !q.dismissed);
  const open = visible.filter((q) => !q.answered);
  const done = visible.filter((q) => q.answered);

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

  async function ask() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await realtime.askQuestion(text, anonymous);
      setDraft("");
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
            {done.length > 0 && open.length > 0 && <SectionLabel title="Open" count={open.length} />}
            {open.map((q) => (
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
              {/* Who this will be asked as — the neutral glyph once "anonymously" is
                  ticked, so the choice is visible before it is sent. */}
              {anonymous ? (
                <GlyphAvatar size="sm" className="mb-1.5" />
              ) : (
                <SenderAvatar
                  name={me.name}
                  identity={me.identity}
                  size="sm"
                  className="mb-1.5"
                />
              )}
              <textarea
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
  isHost,
  myIdentity,
  onUpvote,
  onAnswered,
  onPin,
  onDismiss,
}: {
  question: Question;
  isHost: boolean;
  myIdentity: string;
  onUpvote: () => void;
  onAnswered: (answer: string) => void;
  onPin: () => void;
  onDismiss: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const author = questionAuthor(q, myIdentity);
  const answered = answerKind(q);

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
            className={`text-[13px] leading-relaxed break-words wrap-anywhere ${
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
          {answered === "live" && (
            <p className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-ok/25 bg-ok-soft px-2 text-[10.5px] leading-5 font-semibold text-ok">
              <CheckIcon className="size-3" />
              Answered live
            </p>
          )}
        </div>

        {/* The upvote, as a pill: count and arrow together, filled once it is yours. */}
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
          {!q.answered && (
            <HostAction onClick={() => onAnswered("")} tone="ok" title="Mark as answered">
              <CheckIcon className="size-3.5" />
              Mark answered
            </HostAction>
          )}
        </div>
      )}
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

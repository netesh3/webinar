"use client";

import { useState } from "react";
import { Alert } from "../controls";
import { ArrowUpIcon, CheckIcon, SendIcon } from "../icons";
import { useRoomUI } from "./context";

/* Q&A.
 *
 * Separate from chat because it is a different shape of thing: questions are
 * upvoted, worked through and marked answered, and mixing them into a chat
 * stream means the good question scrolls away while the host is still talking.
 *
 * Ordering is decided in lib/realtime.ts — unanswered first, then most upvoted,
 * then oldest. That is the order a host actually works down.
 */

const MAX_CHARS = 600;

export function QAPanel() {
  const { realtime, controls, isHost, permissions, me } = useRoomUI();
  const [draft, setDraft] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);

  const off = !controls.qaEnabled;
  const open = realtime.questions.filter((q) => !q.answered);
  const done = realtime.questions.filter((q) => q.answered);

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

        {realtime.questions.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
            No questions yet.
            <br />
            {permissions.canPublish
              ? "Questions from the audience land here."
              : "Ask the first one below."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {open.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                isHost={isHost}
                mine={q.from.identity === me.identity}
                onUpvote={() => void realtime.upvote(q.id)}
                onAnswered={() => void realtime.markAnswered(q.id)}
              />
            ))}

            {done.length > 0 && (
              <>
                <p className="pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                  Answered · {done.length}
                </p>
                {done.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    isHost={isHost}
                    mine={q.from.identity === me.identity}
                    onUpvote={() => void realtime.upvote(q.id)}
                    onAnswered={() => void realtime.markAnswered(q.id)}
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
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
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

function QuestionCard({
  question: q,
  isHost,
  mine,
  onUpvote,
  onAnswered,
}: {
  question: {
    id: string;
    text: string;
    votes: number;
    answered: boolean;
    votedByMe: boolean;
    anonymous: boolean;
    at: number;
    from: { name: string; role: string };
  };
  isHost: boolean;
  mine: boolean;
  onUpvote: () => void;
  onAnswered: () => void;
}) {
  // "Anonymous" is honoured for everyone including the host. Showing the host a
  // name the asker chose to withhold would make the checkbox a lie.
  const who = q.anonymous ? "Anonymous" : mine ? "You" : q.from.name;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        q.answered ? "border-line bg-surface-2/60" : "border-line bg-surface"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={onUpvote}
          disabled={q.votedByMe}
          aria-label={q.votedByMe ? "You upvoted this" : "Upvote this question"}
          className={`flex w-9 shrink-0 flex-col items-center gap-0.5 rounded-md border py-1 text-[11px] font-semibold transition-colors ${
            q.votedByMe
              ? "border-brand-line bg-brand-soft text-brand"
              : "border-line-2 text-ink-2 hover:border-brand-line hover:text-brand"
          }`}
        >
          <ArrowUpIcon className="size-3.5" />
          <span className="tabular-nums">{q.votes}</span>
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={`text-[13px] leading-relaxed break-words wrap-anywhere ${
              q.answered ? "text-ink-2 line-through decoration-ink-3/40" : "text-ink"
            }`}
          >
            {q.text}
          </p>
          <p className="mt-1 text-[11px] text-ink-3">
            {who}
            {" · "}
            {new Date(q.at).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>

        {isHost && !q.answered && (
          <button
            type="button"
            onClick={onAnswered}
            title="Mark as answered"
            aria-label="Mark as answered"
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-ok-soft hover:text-ok"
          >
            <CheckIcon className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

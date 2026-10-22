"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, ConfirmModal, Spinner } from "../controls";
import { SparklesIcon, TrashIcon } from "../icons";
import { useToast } from "../providers";
import { Badge, Button, Card, Empty } from "../ui";
import { api } from "@/lib/api";
import {
  PastAnswerPending,
  type PastAnswer,
  type PastAnswers,
} from "@/lib/api-types";
import {
  filterPastAnswers,
  knowledgeError,
  PAST_ANSWER_MAX,
  PAST_QUESTION_MAX,
  pastAnswerProblem,
  pastAnswerSource,
  pastAnswersSummary,
  updatedFromLabel,
} from "@/lib/knowledge";

/* "✨ Past answers" on the AI knowledge page: the answers the host already gave in their
 * sessions, one question and answer each, which the Q&A assistant drafts from next time.
 * Typed answers arrive approved when a session ends; answers given out loud are drafted by the
 * AI from the transcript and wait here for Approve / Edit / Skip. Only the text is kept, never
 * who asked. See api/internal/api/knowledge_answers.go. */

export function PastAnswersSection() {
  const { notify } = useToast();
  const [data, setData] = useState<PastAnswers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<PastAnswer | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.pastAnswers());
      setError(null);
    } catch (err) {
      setError(knowledgeError(err, "Couldn't load your past answers."));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .pastAnswers()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(knowledgeError(err, "Couldn't load your past answers."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function remove() {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await api.deletePastAnswer(deleting.id);
      setDeleting(null);
      await load();
    } catch (err) {
      notify(knowledgeError(err, "Couldn't delete that answer."), "error");
    } finally {
      setBusyDelete(false);
    }
  }

  const list = data ? filterPastAnswers(data.answers, query) : [];
  return (
    <section aria-label="Past answers" className="mt-8">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <SparklesIcon className="size-4 text-brand" />
          Past answers
        </h2>
        {data && (
          <p className="text-[12px] text-ink-3 tabular-nums">
            {pastAnswersSummary(data.pending, data.approved)}
          </p>
        )}
      </div>
      <p className="mb-3 text-[12.5px] text-ink-2">
        What you answered in your sessions, saved when each one ends. Answers
        you gave out loud are drafted from the transcript for you to check
        first. Only the question and answer are kept, never who asked; phone
        numbers and emails are removed.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-3" />
        </div>
      )}
      {data &&
        (data.answers.length === 0 ? (
          <Empty
            title="No past answers yet"
            hint="When a session ends, the questions you answered in Q&A appear here and help the assistant draft next time."
          />
        ) : (
          <>
            {data.answers.length > 5 && (
              <div className="mb-3">
                <label className="sr-only" htmlFor="pa-search">
                  Search past answers
                </label>
                <input
                  id="pa-search"
                  className="field"
                  placeholder="Search questions and answers"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
            {list.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                Nothing matches “{query}”.
              </p>
            ) : (
              <ul className="grid gap-2.5">
                {list.map((a) => (
                  <PastAnswerRow
                    key={a.id}
                    entry={a}
                    onChanged={() => void load()}
                    onDelete={() => setDeleting(a)}
                  />
                ))}
              </ul>
            )}
          </>
        ))}
      <ConfirmModal
        open={deleting !== null}
        busy={busyDelete}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title="Delete this answer?"
        body="The assistant stops drafting from it. It won't come back from the session it was saved from."
        confirmLabel="Delete answer"
      />
    </section>
  );
}

function PastAnswerRow({
  entry,
  onChanged,
  onDelete,
}: {
  entry: PastAnswer;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const { notify } = useToast();
  const pending = entry.status === PastAnswerPending;
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(entry.question);
  const [answer, setAnswer] = useState(entry.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = pastAnswerSource(entry);
  const updated = updatedFromLabel(entry);

  async function run(action: () => Promise<{ merged: boolean }>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      setEditing(false);
      notify(
        res.merged
          ? "Approved: it matched an answer you had, which is now updated."
          : done,
        "info",
      );
      onChanged();
    } catch (err) {
      setError(knowledgeError(err, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = pastAnswerProblem(question, answer);
    if (problem) {
      setError(problem);
      return;
    }
    void run(
      () =>
        pending
          ? api.approvePastAnswer(entry.id, question, answer)
          : api.editPastAnswer(entry.id, question, answer),
      pending ? "Approved." : "Saved.",
    );
  }

  async function skip() {
    setBusy(true);
    try {
      await api.deletePastAnswer(entry.id);
      notify("Skipped.", "info");
      onChanged();
    } catch (err) {
      notify(knowledgeError(err, "Couldn't skip that."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <Card className={`px-4 py-3 ${pending ? "border-brand/40" : ""}`}>
        {editing ? (
          <form onSubmit={save} className="grid gap-2">
            <label className="label" htmlFor={`pa-q-${entry.id}`}>
              Question
            </label>
            <input
              id={`pa-q-${entry.id}`}
              className="field"
              value={question}
              maxLength={PAST_QUESTION_MAX}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <label className="label" htmlFor={`pa-a-${entry.id}`}>
              Answer
            </label>
            <textarea
              id={`pa-a-${entry.id}`}
              className="field min-h-24"
              rows={4}
              value={answer}
              maxLength={PAST_ANSWER_MAX}
              onChange={(e) => setAnswer(e.target.value)}
            />
            {error && <p className="text-[12.5px] text-live">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <Spinner className="size-4" />}
                {pending ? "Approve" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQuestion(entry.question);
                  setAnswer(entry.answer);
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium break-words text-ink">
                  {entry.question}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">
                  {entry.answer}
                </p>
              </div>
              {pending && (
                <Badge tone="brand">
                  <SparklesIcon className="size-3" />
                  Drafted from what you said
                </Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11.5px] text-ink-3">
                {updated ?? (source ? `From ${source}` : "")}
                {updated && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="font-medium text-brand hover:underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.undoPastAnswer(entry.id),
                          "Previous version restored.",
                        )
                      }
                    >
                      Undo
                    </button>
                  </>
                )}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                {pending ? (
                  <>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api.approvePastAnswer(
                              entry.id,
                              entry.question,
                              entry.answer,
                            ),
                          "Approved.",
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void skip()}
                    >
                      Skip
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onDelete}
                      aria-label="Delete this answer"
                    >
                      <TrashIcon className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            {error && <p className="mt-1 text-[12.5px] text-live">{error}</p>}
          </>
        )}
      </Card>
    </li>
  );
}

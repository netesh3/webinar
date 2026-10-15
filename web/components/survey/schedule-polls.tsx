"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { Poll, PollInput, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import {
  buildPollInput,
  draftFromPoll,
  type ComposerDraft,
} from "@/lib/poll-view";
import { Spinner } from "../controls";
import { PlusIcon, TrashIcon } from "../icons";
import { Composer } from "../room/poll-composer";
import { SchedulePollPreview } from "../schedule/poll-preview";

/* Live polls on the schedule Feedback step.
 *
 * Same persistence shape as the feedback survey: draft locally, write after the
 * webinar saves. Only drafts are created or removed here — open and closed polls
 * belong to the room and are left alone. Launch stays a room action. */

type Load = "loading" | "ready" | "error";

type Entry = {
  key: string;
  /** Present once this row exists on the server. */
  serverId: string | null;
  draft: ComposerDraft;
  /** Server state; local-only rows are always draft. */
  state: Poll["state"];
};

export interface SchedulePolls {
  node: ReactNode;
  preview: ReactNode | null;
  problem: () => string | null;
  persist: (slug: string) => Promise<string | null>;
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `poll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function inputFingerprint(input: PollInput): string {
  return JSON.stringify({
    question: input.question,
    kind: input.kind,
    options: input.options,
    correctOption: input.correctOption ?? null,
  });
}

function entryInput(entry: Entry): PollInput | null {
  const built = buildPollInput(entry.draft);
  return built.ok ? built.input : null;
}

function fromServer(list: Poll[]): Entry[] {
  return list.map((p) => ({
    key: p.id,
    serverId: p.id,
    draft: draftFromPoll(p),
    state: p.state,
  }));
}

export function useSchedulePolls(webinar: Webinar | null): SchedulePolls {
  const editing = webinar !== null;
  const bypass = isDevAuthBypassActive();
  const [load, setLoad] = useState<Load>(
    editing && !bypass ? "loading" : "ready",
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  /** Server draft ids as last loaded — used to detect deletes on persist. */
  const [baselineDraftIds, setBaselineDraftIds] = useState<string[]>([]);
  const [baselinePrints, setBaselinePrints] = useState<Record<string, string>>(
    {},
  );
  const [composing, setComposing] = useState<{
    mode: "new" | "edit";
    key?: string;
    quiz: boolean;
    initial?: ComposerDraft;
  } | null>(null);
  const [previewPollKey, setPreviewPollKey] = useState<string | null>(null);
  const [previewQuizKey, setPreviewQuizKey] = useState<string | null>(null);

  const slug = webinar?.id;
  useEffect(() => {
    if (!slug || bypass) return;
    let live = true;
    api
      .hostPolls(slug)
      .then((list) => {
        if (!live) return;
        const next = fromServer(list);
        setEntries(next);
        const drafts = list.filter((p) => p.state === "draft");
        setBaselineDraftIds(drafts.map((p) => p.id));
        const prints: Record<string, string> = {};
        for (const p of drafts) {
          const built = buildPollInput(draftFromPoll(p));
          if (built.ok) prints[p.id] = inputFingerprint(built.input);
        }
        setBaselinePrints(prints);
        const firstPoll = next.find((e) => !e.draft.quiz);
        const firstQuiz = next.find((e) => e.draft.quiz);
        setPreviewPollKey(firstPoll?.key ?? null);
        setPreviewQuizKey(firstQuiz?.key ?? null);
        setLoad("ready");
      })
      .catch(() => {
        if (live) setLoad("error");
      });
    return () => {
      live = false;
    };
  }, [slug, bypass]);

  const polls = useMemo(
    () => entries.filter((e) => !e.draft.quiz),
    [entries],
  );
  const quizzes = useMemo(
    () => entries.filter((e) => e.draft.quiz),
    [entries],
  );

  // Keep preview keys pointed at something that still exists.
  useEffect(() => {
    if (previewPollKey && !polls.some((e) => e.key === previewPollKey)) {
      setPreviewPollKey(polls[0]?.key ?? null);
    } else if (!previewPollKey && polls[0]) {
      setPreviewPollKey(polls[0].key);
    }
    if (previewQuizKey && !quizzes.some((e) => e.key === previewQuizKey)) {
      setPreviewQuizKey(quizzes[0]?.key ?? null);
    } else if (!previewQuizKey && quizzes[0]) {
      setPreviewQuizKey(quizzes[0].key);
    }
  }, [polls, quizzes, previewPollKey, previewQuizKey]);

  function problem(): string | null {
    if (load !== "ready") return null;
    if (composing) {
      return "Finish or cancel the poll you’re writing before this can be saved.";
    }
    return null;
  }

  async function persist(target: string): Promise<string | null> {
    if (load !== "ready" || bypass) return null;
    try {
      const keepIds = new Set<string>();
      const removedIds = new Set<string>();
      for (const entry of entries) {
        if (entry.state !== "draft") {
          if (entry.serverId) keepIds.add(entry.serverId);
          continue;
        }
        const input = entryInput(entry);
        if (!input) continue;

        const print = inputFingerprint(input);
        if (entry.serverId && baselinePrints[entry.serverId] === print) {
          keepIds.add(entry.serverId);
          continue;
        }

        const created = await api.createPoll(target, input);
        keepIds.add(created.id);
        if (entry.serverId) {
          await api.deletePoll(target, entry.serverId).catch(() => {
            /* Leave the old draft rather than lose the new one. */
          });
          removedIds.add(entry.serverId);
        }
      }

      for (const id of baselineDraftIds) {
        if (keepIds.has(id) || removedIds.has(id)) continue;
        await api.deletePoll(target, id);
      }

      // Refresh baseline from what we just wrote so a second save is a no-op.
      const list = await api.hostPolls(target);
      const next = fromServer(list);
      setEntries(next);
      const drafts = list.filter((p) => p.state === "draft");
      setBaselineDraftIds(drafts.map((p) => p.id));
      const prints: Record<string, string> = {};
      for (const p of drafts) {
        const built = buildPollInput(draftFromPoll(p));
        if (built.ok) prints[p.id] = inputFingerprint(built.input);
      }
      setBaselinePrints(prints);
      return null;
    } catch (e) {
      return e instanceof Error
        ? `Saved the webinar, but not the live polls: ${e.message}`
        : "Saved the webinar, but not the live polls.";
    }
  }

  function saveComposed(input: PollInput) {
    const draft: ComposerDraft = {
      question: input.question,
      options: input.options,
      quiz: input.kind === "quiz",
      correct: input.correctOption ?? 0,
    };
    if (composing?.mode === "edit" && composing.key) {
      setEntries((list) =>
        list.map((e) =>
          e.key === composing.key
            ? { ...e, draft, state: "draft" as const }
            : e,
        ),
      );
      if (draft.quiz) setPreviewQuizKey(composing.key);
      else setPreviewPollKey(composing.key);
    } else {
      const key = newKey();
      setEntries((list) => [
        ...list,
        { key, serverId: null, draft, state: "draft" },
      ]);
      if (draft.quiz) setPreviewQuizKey(key);
      else setPreviewPollKey(key);
    }
    setComposing(null);
  }

  function remove(key: string) {
    setEntries((list) => list.filter((e) => e.key !== key));
    if (composing?.key === key) setComposing(null);
  }

  const previewPoll = polls.find((e) => e.key === previewPollKey) ?? polls[0];
  const previewQuiz =
    quizzes.find((e) => e.key === previewQuizKey) ?? quizzes[0];

  const preview =
    previewPoll || previewQuiz ? (
      <>
        {previewPoll && (
          <SchedulePollPreview
            draft={previewPoll.draft}
            label="Poll preview"
            hint={
              polls.length > 1
                ? `${polls.findIndex((e) => e.key === previewPoll.key) + 1} of ${polls.length} · click a poll to switch`
                : undefined
            }
          />
        )}
        {previewQuiz && (
          <SchedulePollPreview
            draft={previewQuiz.draft}
            label="Quiz preview"
            hint={
              quizzes.length > 1
                ? `${quizzes.findIndex((e) => e.key === previewQuiz.key) + 1} of ${quizzes.length} · click a quiz to switch`
                : undefined
            }
          />
        )}
      </>
    ) : null;

  const node = (
    <div id="live-polls" className="grid scroll-mt-24 gap-3">
      {load === "loading" ? (
        <Spinner className="size-5" />
      ) : load === "error" ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-[12.5px] text-warn">
          Couldn&apos;t load this webinar&apos;s polls, so saving here
          won&apos;t touch them. Reload to try again.
        </p>
      ) : (
        <>
          {entries.length === 0 && !composing && (
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              No polls yet. Add a couple now so during the webinar you only tap
              Launch.
            </p>
          )}

          {entries.length > 0 && (
            <ul className="grid gap-2">
              {entries.map((entry) => {
                const built = buildPollInput(entry.draft);
                const n = built.ok
                  ? built.input.options.length
                  : entry.draft.options.filter((o) => o.trim()).length;
                const quiz = entry.draft.quiz;
                const previewing =
                  (quiz && previewQuiz?.key === entry.key) ||
                  (!quiz && previewPoll?.key === entry.key);
                const editable = entry.state === "draft";
                return (
                  <li key={entry.key}>
                    <div
                      className={`grid grid-cols-[1fr_auto] items-center gap-2 rounded-[10px] border px-3.5 py-3 ${
                        previewing
                          ? quiz
                            ? "border-warn/40 bg-warn-soft/60"
                            : "border-brand-line bg-brand-soft"
                          : "border-line bg-surface-2/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (quiz) setPreviewQuizKey(entry.key);
                          else setPreviewPollKey(entry.key);
                        }}
                        className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-md"
                      >
                        <strong className="block truncate text-[13.5px] font-semibold text-ink">
                          {entry.draft.question.trim() || "Untitled question"}
                        </strong>
                        <span className="mt-0.5 block text-[12px] text-ink-3">
                          {quiz ? "Quiz" : "Poll"}
                          {n > 0 ? ` · ${n} options` : ""}
                          {quiz && built.ok ? " · correct answer set" : ""}
                          {entry.state === "open"
                            ? " · live now"
                            : entry.state === "closed"
                              ? " · already used"
                              : ""}
                        </span>
                      </button>
                      <div className="flex items-center gap-1.5">
                        {previewing && (
                          <span
                            className={`rounded-full border bg-surface px-2 py-0.5 text-[10.5px] font-bold ${
                              quiz
                                ? "border-warn/35 text-warn"
                                : "border-brand-line text-brand"
                            }`}
                          >
                            In preview
                          </span>
                        )}
                        {editable && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setComposing({
                                  mode: "edit",
                                  key: entry.key,
                                  quiz,
                                  initial: entry.draft,
                                })
                              }
                              className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(entry.key)}
                              aria-label="Remove"
                              className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-surface hover:text-live outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                            >
                              <TrashIcon className="size-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {composing ? (
            <Composer
              initial={
                composing.initial ?? {
                  question: "",
                  options: ["", ""],
                  quiz: composing.quiz,
                  correct: 0,
                }
              }
              editing={composing.mode === "edit"}
              liveQuestion={null}
              allowLaunch={false}
              onSave={async (input) => {
                saveComposed(input);
              }}
              onCancel={() => setComposing(null)}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <AddButton
                label="Add poll"
                onClick={() => setComposing({ mode: "new", quiz: false })}
              />
              <AddButton
                label="Add quiz"
                onClick={() => setComposing({ mode: "new", quiz: true })}
              />
            </div>
          )}

          <p className="rounded-lg bg-brand-soft px-2.5 py-2 text-[12px] leading-relaxed text-brand">
            Tip: add 2–3 polls max. You can still create one live if needed.
          </p>
        </>
      )}
    </div>
  );

  return { node, preview, problem, persist };
}

function AddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const id = useId();
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-brand-line bg-brand-soft/40 px-2.5 text-[12.5px] font-medium text-brand transition-colors hover:border-brand hover:bg-brand-soft outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <PlusIcon className="size-3.5" />
      {label}
    </button>
  );
}

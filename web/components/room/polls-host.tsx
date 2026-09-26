"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Poll, PollInput } from "@/lib/api-types";
import { useCoalescingReader } from "@/lib/polls";
import { draftFromPoll, groupPolls, pollResults, type ComposerDraft } from "@/lib/poll-view";
import { Alert, Spinner } from "../controls";
import { CopyIcon, PlayIcon, PlusIcon, PollIcon, RotateCcwIcon, StopIcon, TrashIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";
import { Composer } from "./poll-composer";
import { KindPill, ResultRows, SectionLabel, StatePill, votesLabel } from "./poll-pieces";

/** How often the host refreshes an open poll's tally. */
const TALLY_POLL_MS = 4000;

/** Reads the host's polls, and re-reads on the room's nudge.
 *
 *  `realtime.pollsRevision` is bumped when the server announces a change (including
 *  one made by a co-host). The timer on top of that is only for the tally of an open
 *  poll, so it runs only while one is open. Reads are serialised without dropping
 *  any — see coalescingReader. */
function useHostPolls(slug: string) {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { realtime } = useRoomUI();

  const read = useCallback(async () => {
    try {
      setPolls(await api.hostPolls(slug));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the polls.");
    }
  }, [slug]);
  const request = useCoalescingReader(read);

  useEffect(() => {
    request();
  }, [request, read, realtime.pollsRevision]);

  const live = (polls ?? []).some((p) => p.state === "open");
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(request, TALLY_POLL_MS);
    return () => clearInterval(timer);
  }, [live, request]);

  return { polls, error, reload: request };
}

type Composing = { mode: "new"; initial?: ComposerDraft } | { mode: "edit"; poll: Poll };

export function HostPolls() {
  const { slug } = useRoomUI();
  const { notify } = useToast();
  const { polls, error, reload } = useHostPolls(slug);
  const [busy, setBusy] = useState<string | null>(null);
  const [composing, setComposing] = useState<Composing | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const groups = groupPolls(polls ?? []);
  const current = groups.live[0] ?? null;

  const act = useCallback(
    async (id: string, label: string, run: () => Promise<unknown>) => {
      setBusy(id);
      setFailed(null);
      try {
        await run();
        notify(label, "ok");
        reload();
      } catch (err) {
        setFailed(err instanceof Error ? err.message : "That didn't work.");
      } finally {
        setBusy(null);
      }
    },
    [notify, reload],
  );

  const launchedLabel = (poll: Pick<Poll, "kind">, again = false) =>
    `${poll.kind === "quiz" ? "Quiz" : "Poll"} is live — attendees are seeing it ${again ? "again" : "now"}`;

  const launch = (poll: Poll) =>
    act(poll.id, launchedLabel(poll, poll.state === "closed"), () => api.openPoll(slug, poll.id));

  /* Saving from the composer. There is no update endpoint, so editing a draft is
   * "write the new one, then remove the old one" — safe for a draft precisely
   * because a draft has never been shown and has no votes. The new draft is written
   * first so a failure part-way leaves a duplicate rather than a lost question. */
  async function saveComposed(input: PollInput, launchNow: boolean) {
    const created = await api.createPoll(slug, input);
    if (composing?.mode === "edit") {
      await api.deletePoll(slug, composing.poll.id).catch(() => {
        notify("Saved — but the old draft is still there. Delete it by hand.", "info");
      });
    }
    if (launchNow) {
      try {
        await api.openPoll(slug, created.id);
        notify(launchedLabel(created), "ok");
      } catch (err) {
        // Saved but not launched: close the composer anyway, or a retry from it
        // would write the same question twice.
        setFailed(
          `Saved as a draft, but it didn't launch: ${
            err instanceof Error ? err.message : "try Launch again"
          }`,
        );
      }
    } else {
      notify(composing?.mode === "edit" ? "Draft updated." : "Saved as a draft.", "ok");
    }
    setComposing(null);
    reload();
  }

  const empty = polls !== null && polls.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error && (
          <div className="mb-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {failed && (
          <div className="mb-3">
            <Alert tone="error">{failed}</Alert>
          </div>
        )}

        {composing && (
          <div className="mb-3">
            <Composer
              key={composing.mode === "edit" ? composing.poll.id : "new"}
              editing={composing.mode === "edit"}
              initial={composing.mode === "edit" ? draftFromPoll(composing.poll) : composing.initial}
              liveQuestion={current?.question ?? null}
              onSave={saveComposed}
              onCancel={() => setComposing(null)}
            />
          </div>
        )}

        {polls === null && !error ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-ink-3" />
          </div>
        ) : empty && !composing ? (
          <EmptyHost onCreate={() => setComposing({ mode: "new" })} />
        ) : (
          <div className="space-y-2.5">
            {groups.live.length > 0 && (
              <>
                <SectionLabel title="Live" count={groups.live.length} hint="Updates every few seconds" />
                {groups.live.map((poll) => (
                  <HostPollCard
                    key={poll.id}
                    poll={poll}
                    busy={busy === poll.id}
                    locked={busy !== null}
                    onClose={() =>
                      void act(
                        poll.id,
                        poll.kind === "quiz"
                          ? "Voting closed — attendees can now see the answer."
                          : "Voting closed.",
                        () => api.closePoll(slug, poll.id),
                      )
                    }
                    onDelete={() => void act(poll.id, "Poll deleted.", () => api.deletePoll(slug, poll.id))}
                  />
                ))}
              </>
            )}

            {groups.drafts.length > 0 && (
              <>
                <SectionLabel
                  title="Drafts"
                  count={groups.drafts.length}
                  spaced={groups.live.length > 0}
                  hint={current ? "Launching one closes the live question" : undefined}
                />
                {groups.drafts.map((poll) => (
                  <HostPollCard
                    key={poll.id}
                    poll={poll}
                    busy={busy === poll.id}
                    locked={busy !== null}
                    liveQuestion={current?.question ?? null}
                    onLaunch={() => void launch(poll)}
                    onEdit={() => setComposing({ mode: "edit", poll })}
                    onDelete={() => void act(poll.id, "Draft deleted.", () => api.deletePoll(slug, poll.id))}
                  />
                ))}
              </>
            )}

            {groups.closed.length > 0 && (
              <>
                <SectionLabel
                  title="Closed"
                  count={groups.closed.length}
                  spaced={groups.live.length + groups.drafts.length > 0}
                />
                {groups.closed.map((poll) => (
                  <HostPollCard
                    key={poll.id}
                    poll={poll}
                    busy={busy === poll.id}
                    locked={busy !== null}
                    liveQuestion={current?.question ?? null}
                    onLaunch={() => void launch(poll)}
                    onDuplicate={() => setComposing({ mode: "new", initial: draftFromPoll(poll) })}
                    onDelete={() => void act(poll.id, "Poll deleted.", () => api.deletePoll(slug, poll.id))}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {!composing && !empty && (
        <div className="shrink-0 border-t border-line p-2.5">
          <button
            type="button"
            onClick={() => setComposing({ mode: "new" })}
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-[13px] font-semibold text-stage transition-colors hover:bg-brand-hover outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:h-9"
          >
            <PlusIcon className="size-4" />
            New poll or quiz
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyHost({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-2xl bg-brand-soft text-brand">
        <PollIcon className="size-5" />
      </span>
      <p className="mt-3 text-[13px] font-semibold text-ink">Ask the room something</p>
      <p className="mt-1 max-w-[16rem] text-[12px] leading-relaxed text-ink-3">
        Write a poll or a quiz now and launch it when you&apos;re ready. It pops up in the
        middle of every attendee&apos;s screen.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12.5px] font-semibold text-stage transition-colors hover:bg-brand-hover outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <PlusIcon className="size-4" />
        New poll or quiz
      </button>
    </div>
  );
}

function HostPollCard({
  poll,
  busy,
  locked,
  liveQuestion = null,
  onLaunch,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  poll: Poll;
  busy: boolean;
  /** Another action is running; hold off so two requests do not race. */
  locked: boolean;
  liveQuestion?: string | null;
  onLaunch?: () => void;
  onClose?: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const open = poll.state === "open";
  const draft = poll.state === "draft";
  const { total } = pollResults(poll);

  return (
    <article
      aria-label={`${poll.kind === "quiz" ? "Quiz" : "Poll"}: ${poll.question}`}
      className={`rounded-xl border px-3 py-2.5 ${
        open
          ? "border-brand-line bg-brand-soft/40 shadow-[0_0_0_1px_var(--color-brand-line)]"
          : draft
            ? "border-dashed border-line-2 bg-surface"
            : "border-line bg-surface-2/40"
      }`}
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <StatePill poll={poll} />
        <KindPill poll={poll} />
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-3">
          {draft ? `${poll.options.length} options` : votesLabel(total)}
        </span>
      </header>

      <p className="mt-1.5 text-[13px] leading-snug font-semibold break-words wrap-anywhere text-ink">
        {poll.question}
      </p>

      <div className="mt-2">
        <ResultRows poll={poll} showMine={false} highlightLeader={!draft} showTally={!draft} />
      </div>

      {open && total === 0 && (
        <p className="mt-1.5 text-[11px] text-ink-3">Waiting for the first answer…</p>
      )}
      {!open && !draft && poll.kind === "quiz" && total > 0 && (
        <p className="mt-1.5 text-[11px] text-ink-3">
          {pollResults(poll).rows.find((r) => r.correct)?.percent ?? 0}% got it right.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-line pt-2">
        {confirmDelete ? (
          <>
            <span className="mr-auto text-[11.5px] text-ink-2">
              Delete {total > 0 ? `it and its ${votesLabel(total)}` : "this"}?
            </span>
            <HostButton onClick={() => setConfirmDelete(false)}>Keep</HostButton>
            <HostButton
              tone="danger"
              busy={busy}
              disabled={locked}
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
            >
              <TrashIcon className="size-3.5" />
              Delete
            </HostButton>
          </>
        ) : (
          <>
            {open && onClose && (
              <HostButton tone="primary" busy={busy} disabled={locked} onClick={onClose}>
                <StopIcon className="size-3.5" />
                Close voting
              </HostButton>
            )}
            {!open && onLaunch && (
              <HostButton
                tone={draft ? "primary" : "neutral"}
                busy={busy}
                disabled={locked}
                onClick={onLaunch}
                title={
                  liveQuestion
                    ? `Launching closes “${liveQuestion}”`
                    : draft
                      ? "Show it to the room now"
                      : "Open voting again — earlier votes are kept"
                }
              >
                {draft ? <PlayIcon className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
                {draft ? "Launch" : "Reopen"}
              </HostButton>
            )}
            {onEdit && (
              <HostButton disabled={locked} onClick={onEdit}>
                Edit
              </HostButton>
            )}
            {onDuplicate && (
              <HostButton disabled={locked} onClick={onDuplicate} title="Start a new draft from this one, with no votes">
                <CopyIcon className="size-3.5" />
                Duplicate
              </HostButton>
            )}
            <span className="flex-1" />
            <button
              type="button"
              disabled={locked}
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete this poll"
              title="Delete"
              className="grid min-h-11 min-w-11 place-items-center rounded-md text-ink-3 transition-colors hover:bg-live-soft hover:text-live disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 md:min-w-7"
            >
              <TrashIcon className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function HostButton({
  children,
  onClick,
  busy = false,
  disabled = false,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: "primary" | "neutral" | "danger";
  title?: string;
}) {
  const tones = {
    primary: "bg-brand font-semibold text-stage hover:bg-brand-hover",
    neutral: "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "bg-live-soft font-semibold text-live hover:bg-live/20",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      title={title}
      className={`inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7 ${tones[tone]}`}
    >
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

"use client";

import { useCallback, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { RegistrantRow, RegistrationState } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { useToast } from "./providers";
import { Button, Card, SectionTitle } from "./ui";
import { Spinner } from "./controls";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/clock";

/* The host's approval queue: tick who gets in, decide in one go.
 *
 * Replaces a panel that offered exactly two things — approve one person, or approve everybody
 * waiting. Both are the wrong shape for the job this does. A host reviewing forty strangers
 * approves most and declines a few, and neither "one at a time" nor "all of them" expresses
 * that: the first is forty requests, the second is a decision they did not make.
 *
 * ONE REQUEST FOR THE WHOLE SELECTION, not one per row. That is not only about speed. Forty
 * separate PATCHes are forty transactions, and a failure at number twenty leaves the room half
 * approved with nothing in the UI to say which half — so the host's only safe move is to reload
 * and re-read every row. The batch endpoint is atomic, so the answer is always "all of it" or
 * "none of it".
 *
 * SELECTION IS LOCAL STATE, deliberately. It is not in the URL and not persisted: a
 * half-finished selection that survives a reload is a trap, because the rows may have changed
 * underneath it and the host would be approving from a stale list.
 */

export function ApprovalQueue({
  slug,
  pending,
  onChanged,
}: {
  slug: string;
  pending: RegistrantRow[];
  onChanged: () => Promise<void> | void;
}) {
  const { notify } = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | "batch" | string>(null);
  // null until hydration, so the server and the browser render the same relative times.
  const now = useNow();

  /* Selection is intersected with the rows that actually exist on every render.
   *
   * Without this, approving two of three leaves their ids in `chosen` while they vanish from
   * `pending`, and the next batch would send ids the server has already handled — reported as
   * "changed 0" and read by the host as "the button is broken". */
  const live = useMemo(() => {
    const ids = new Set(pending.map((r) => r.id));
    return [...chosen].filter((id) => ids.has(id));
  }, [chosen, pending]);

  const allChosen = pending.length > 0 && live.length === pending.length;

  const toggle = useCallback((id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setChosen((prev) =>
      prev.size >= pending.length
        ? new Set()
        : new Set(pending.map((r) => r.id)),
    );
  }, [pending]);

  async function decide(
    ids: string[],
    state: RegistrationState,
    label: string,
  ) {
    if (ids.length === 0) return;
    setBusy(ids.length === 1 ? ids[0] : "batch");
    try {
      if (isDevAuthBypassActive()) {
        notify(
          `${label} ${ids.length} (preview — not saved).`,
          "ok",
        );
        setChosen(new Set());
        await onChanged();
        return;
      }
      const out = await api.decideApprovals(slug, ids, state);
      /* Report what CHANGED, not what was asked for.
       *
       * They differ when a row was already in that state — two hosts working the same queue,
       * or a double click. Saying "approved 5" when three were already approved is a lie the
       * host would only catch by counting rows. */
      if (out.changed === 0) {
        notify("Nothing to change — those were already decided.", "ok");
      } else {
        const who =
          out.changed === 1
            ? out.rows[0]?.name || "1 person"
            : `${out.changed} people`;
        notify(
          out.notified > 0
            ? `${label} ${who}. ${out.notified} notified.`
            : `${label} ${who}.`,
          "ok",
        );
      }
      setChosen(new Set());
      await onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  if (pending.length === 0) return null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Pending registrations · {pending.length}</SectionTitle>

        <div className="flex items-center gap-2">
          {/* The count is on the buttons rather than in a separate line, so the host can
              see what they are about to do without looking away from the thing they click. */}
          <Button
            size="sm"
            disabled={busy !== null || live.length === 0}
            onClick={() => void decide(live, "approved", "Approved")}
          >
            {busy === "batch" && <Spinner className="size-3.5" />}
            Approve{live.length > 0 ? ` ${live.length}` : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null || live.length === 0}
            onClick={() => void decide(live, "declined", "Declined")}
          >
            Reject{live.length > 0 ? ` ${live.length}` : ""}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line text-[11.5px] tracking-wide text-ink-3 uppercase">
              <th scope="col" className="w-9 py-2 pl-1">
                <input
                  type="checkbox"
                  className="size-3.5 accent-brand"
                  checked={allChosen}
                  /* Indeterminate cannot be expressed as a prop, so it is set on the node.
                     Without it a partial selection shows an unticked box, and the obvious
                     next click clears the selection instead of extending it. */
                  ref={(el) => {
                    if (el) el.indeterminate = live.length > 0 && !allChosen;
                  }}
                  onChange={toggleAll}
                  aria-label={allChosen ? "Deselect all" : "Select all"}
                />
              </th>
              <th scope="col" className="py-2 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 font-medium">
                Email
              </th>
              <th scope="col" className="hidden py-2 font-medium sm:table-cell">
                Registered
              </th>
              <th scope="col" className="py-2 pr-1 text-right font-medium">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => {
              const picked = live.includes(r.id);
              return (
                <tr
                  key={r.id}
                  className={`border-b border-line/60 text-[13px] last:border-0 ${
                    picked ? "bg-brand/5" : ""
                  }`}
                >
                  <td className="py-2.5 pl-1">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-brand"
                      checked={picked}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select ${r.name || r.email}`}
                    />
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">{r.name || "—"}</div>
                    {/* The optional fields, inline. They are collected so a host can decide
                        who this person is, which is the entire purpose of this screen — and
                        making them export a CSV to see the company defeats it. */}
                    {(r.company || r.jobTitle || r.phone) && (
                      <div className="truncate text-[11.5px] text-ink-3">
                        {[r.jobTitle, r.company, r.phone]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[16rem] truncate py-2.5 pr-3 text-ink-2">
                    {r.email}
                  </td>
                  <td className="hidden py-2.5 pr-3 text-ink-3 sm:table-cell">
                    {now ? formatRelative(r.createdAt, new Date(now)) : ""}
                  </td>
                  <td className="py-2.5 pr-1">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void decide([r.id], "approved", "Approved")
                        }
                      >
                        {busy === r.id ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          "Approve"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void decide([r.id], "declined", "Declined")
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
        Approving sends each person their own join link. Rejecting tells them
        too — somebody who registered and hears nothing turns up expecting to be
        let in.
      </p>
    </Card>
  );
}

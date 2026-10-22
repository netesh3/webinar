"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spinner } from "../controls";
import { SparklesIcon } from "../icons";
import { useToast } from "../providers";
import { Card } from "../ui";
import { api } from "@/lib/api";
import type { SessionKnowledgeDoc, SessionPastAnswers } from "@/lib/api-types";
import { knowledgeError, sourceLabel, wordsLabel } from "@/lib/knowledge";

/* "Knowledge for this session" on a webinar's or meeting's Setup tab: the host's AI knowledge
 * documents, each ticked unless left out of this session. Drawn only for an account with the
 * ai feature; see api/internal/api/knowledge.go. */

export function SessionKnowledgeCard({ slug }: { slug: string }) {
  const { notify } = useToast();
  const [docs, setDocs] = useState<SessionKnowledgeDoc[] | null>(null);
  const [past, setPast] = useState<SessionPastAnswers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sessionKnowledge(slug)
      .then((res) => {
        if (!cancelled) {
          setDocs(res.docs);
          setPast(res.pastAnswers);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(knowledgeError(err, "Couldn't load your AI knowledge."));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function toggle(doc: SessionKnowledgeDoc) {
    if (busy) return;
    setBusy(doc.id);
    // Shown at once; put back if the server says no.
    setDocs(
      (cur) =>
        cur?.map((d) =>
          d.id === doc.id ? { ...d, included: !doc.included } : d,
        ) ?? cur,
    );
    try {
      const res = await api.setSessionKnowledge(slug, doc.id, !doc.included);
      setDocs(res.docs);
      setPast(res.pastAnswers);
    } catch (err) {
      setDocs(
        (cur) =>
          cur?.map((d) =>
            d.id === doc.id ? { ...d, included: doc.included } : d,
          ) ?? cur,
      );
      notify(knowledgeError(err, "Couldn't change that."), "error");
    } finally {
      setBusy(null);
    }
  }

  async function togglePast() {
    if (busy || !past) return;
    setBusy("past-answers");
    const was = past.included;
    setPast({ ...past, included: !was });
    try {
      const res = await api.setSessionPastAnswers(slug, !was);
      setDocs(res.docs);
      setPast(res.pastAnswers);
    } catch (err) {
      setPast((cur) => (cur ? { ...cur, included: was } : cur));
      notify(knowledgeError(err, "Couldn't change that."), "error");
    } finally {
      setBusy(null);
    }
  }

  const on = docs?.filter((d) => d.included).length ?? 0;
  const pastItem = past && (
    <li>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-brand)]"
          checked={past.included}
          disabled={busy === "past-answers"}
          onChange={() => void togglePast()}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1 text-[13px] text-ink">
            <SparklesIcon className="size-3.5 text-brand" />
            Past answers
          </span>
          <span className="block text-[11.5px] text-ink-3">
            {past.count === 0
              ? "Your answers from earlier sessions, saved as they end"
              : `${past.count.toLocaleString("en-IN")} ${past.count === 1 ? "answer" : "answers"} from your earlier sessions`}
          </span>
        </span>
      </label>
    </li>
  );
  return (
    <Card className="p-5">
      <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <SparklesIcon className="size-4 text-brand" />
        Knowledge for this session
      </h2>
      <p className="mb-3 text-[12.5px] text-ink-2">
        The Q&amp;A assistant drafts answers from these documents for you to
        review. Untick one this session shouldn&apos;t use.
      </p>
      {error ? (
        <p className="text-[12.5px] text-live">{error}</p>
      ) : docs === null ? (
        <Spinner className="size-4 text-ink-3" />
      ) : docs.length === 0 ? (
        <>
          {pastItem && <ul className="mb-2 grid gap-1">{pastItem}</ul>}
          <p className="text-[12.5px] text-ink-3">
            No documents yet.{" "}
            <Link
              href="/host/knowledge"
              className="font-medium text-brand hover:underline"
            >
              Add your course FAQ
            </Link>{" "}
            to ground the assistant&apos;s answers.
          </p>
        </>
      ) : (
        <>
          <ul className="grid gap-1">
            {pastItem}
            {docs.map((d) => (
              <li key={d.id}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--color-brand)]"
                    checked={d.included}
                    disabled={busy === d.id}
                    onChange={() => void toggle(d)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] break-words text-ink">
                      {d.title}
                    </span>
                    <span className="block text-[11.5px] text-ink-3">
                      {sourceLabel(d.source)} · {wordsLabel(d.words)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11.5px] text-ink-3">
            {on} of {docs.length} in use ·{" "}
            <Link href="/host/knowledge" className="text-brand hover:underline">
              Manage AI knowledge
            </Link>
          </p>
        </>
      )}
    </Card>
  );
}

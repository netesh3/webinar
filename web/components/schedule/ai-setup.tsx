"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Alert } from "../controls";
import { SparklesIcon } from "../icons";
import { useSession, useToast } from "../providers";
import { Button } from "../ui";
import { ApiError, api } from "@/lib/api";
import { FeatureAI, type AIWebinarSetup } from "@/lib/api-types";
import {
  AI_IDEA_MAX,
  AI_LANGUAGES,
  aiErrorMessage,
  fillFromDraft,
  overwrites,
  registrationCopyText,
  socialPostList,
  type AILanguage,
  type SetupFill,
} from "@/lib/ai-setup";
import type { FormState, SetForm } from "./form-state";

/* "Write with AI", above the topic.
 *
 * One line from the host, and the topic and description fill in. The registration copy
 * and a post per channel come back too, offered in a panel with copy buttons rather than
 * put anywhere: the host decides where they go. Nothing is saved — the form is just
 * edited, as if the host had typed it — so Undo is all it takes to go back, and the
 * normal Save is what keeps it.
 *
 * Shown only to an account with the AI switch on; the API refuses the rest anyway, and
 * says so in words if the switch changes while the form is open. */
export function WriteWithAI({ form, set }: { form: FormState; set: SetForm }) {
  const { account } = useSession();
  const { notify } = useToast();
  const ideaId = useId();
  const langId = useId();
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [language, setLanguage] = useState<AILanguage>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AIWebinarSetup | null>(null);
  const [undo, setUndo] = useState<SetupFill | null>(null);
  const inFlight = useRef(false);

  if (!(account?.features ?? []).includes(FeatureAI)) return null;

  const write = async () => {
    const text = idea.trim();
    if (!text) {
      setError("Tell us a little about your webinar first.");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const out = await api.aiWebinarSetup({ idea: text, language });
      const current = { topic: form.topic, description: form.description };
      const next = fillFromDraft(out, current);
      set("topic", next.topic);
      set("description", next.description);
      setUndo(overwrites(current, next) ? current : null);
      setDraft(out);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? aiErrorMessage({ code: err.code, message: err.message, fields: err.fields })
          : aiErrorMessage({}),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied.`, "ok");
    } catch {
      notify("Couldn't reach the clipboard.", "info");
    }
  };

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <SparklesIcon className="size-3.5 text-brand" />
          Write with AI
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-xl border border-brand-line bg-brand-soft/40 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
            <SparklesIcon className="size-3.5 text-brand" />
            Write with AI
          </p>
          <p className="text-[12px] text-ink-3">
            Fills in the topic and description. Edit anything — nothing is saved until you save.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
        <div>
          <label className="label" htmlFor={ideaId}>
            What&apos;s your webinar about?
          </label>
          <input
            id={ideaId}
            className="field"
            maxLength={AI_IDEA_MAX}
            placeholder="e.g. Budgeting for people in their first job"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              // Enter writes the draft instead of submitting the schedule form.
              if (e.key === "Enter") {
                e.preventDefault();
                void write();
              }
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor={langId}>
            Language
          </label>
          <select
            id={langId}
            className="field"
            value={language}
            onChange={(e) => setLanguage(e.target.value as AILanguage)}
          >
            {AI_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void write()} disabled={busy}>
          {busy ? "Writing…" : draft ? "Write again" : "Write draft"}
        </Button>
        {undo && !busy && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              set("topic", undo.topic);
              set("description", undo.description);
              setUndo(null);
            }}
          >
            Undo
          </Button>
        )}
        <span className="text-[11.5px] text-ink-3" aria-live="polite">
          {busy ? "This takes a few seconds." : ""}
        </span>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {draft && !busy && (
        <div className="grid gap-3 border-t border-brand-line pt-3">
          {(draft.registrationHeadline || draft.registrationBullets.length > 0) && (
            <CopyBlock
              title="Registration page"
              onCopy={() => void copy(registrationCopyText(draft), "Registration copy")}
              extra={
                draft.registrationHeadline && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => set("summary", draft.registrationHeadline)}
                    disabled={form.summary === draft.registrationHeadline}
                  >
                    Use headline as summary
                  </Button>
                )
              }
            >
              {draft.registrationHeadline && (
                <p className="font-medium text-ink">{draft.registrationHeadline}</p>
              )}
              {draft.registrationBullets.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {draft.registrationBullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </CopyBlock>
          )}
          {socialPostList(draft).map((p) => (
            <CopyBlock
              key={p.channel}
              title={`${p.channel} post`}
              onCopy={() => void copy(p.text, `${p.channel} post`)}
            >
              <p className="whitespace-pre-line">{p.text}</p>
            </CopyBlock>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyBlock({
  title,
  onCopy,
  extra,
  children,
}: {
  title: string;
  onCopy: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{title}</p>
        <div className="flex gap-1">
          {extra}
          <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
            Copy
          </Button>
        </div>
      </div>
      <div className="text-[13px] text-ink-2">{children}</div>
    </div>
  );
}

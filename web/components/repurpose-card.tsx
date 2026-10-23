"use client";

import { Fragment, useEffect, useState } from "react";
import { ConfirmModal, Spinner } from "./controls";
import { CopyIcon, SparklesIcon } from "./icons";
import { useToast } from "./providers";
import { Badge, Button, Card, SectionTitle } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { BrandVoice, RepurposeDraft, RepurposeResponse, Webinar } from "@/lib/api-types";
import {
  REPURPOSE_FORMATS,
  type Inline,
  draftBadge,
  draftFailedText,
  draftFileName,
  draftsPending,
  formatLabel,
  isPlainFormat,
  lengthNote,
  markdownBlocks,
  repurposeBlockedText,
} from "@/lib/repurpose";

/** How often the card looks again while a draft is being written. Each look also writes. */
const POLL_MS = 5_000;

function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text.endsWith("\n") ? text : `${text}\n`], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

/* Repurpose this session, in AI insights (the "repurpose" switch): drafts for a blog, a
 * newsletter, a whitepaper and social posts, written by AI from what was said, in the host's
 * brand voice.
 *
 * A draft is the AI's until the host has read it: copy and download wait for "Mark as
 * reviewed", and the badge says "AI draft, not reviewed" until then. The server writes the
 * drafts inside requests, so while one is queued or being written this card looks again every
 * few seconds, and that look is what writes it. */
export function RepurposeCard({ webinar }: { webinar: Webinar }) {
  const slug = webinar.id;
  const { notify } = useToast();
  const [data, setData] = useState<RepurposeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(["blog", "linkedin"]));
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api
      .repurposeDrafts(slug, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setData(res);
        setLoadError(null);
        setOpen((o) => (o && res.drafts.some((d) => d.format === o) ? o : (res.drafts[0]?.format ?? null)));
        if (draftsPending(res.drafts)) timer = setTimeout(() => setPoll((n) => n + 1), POLL_MS);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load the drafts. Reload the page to try again.");
      });
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [slug, poll]);

  const generate = async (formats: string[]) => {
    if (generating || formats.length === 0) return;
    setGenerating(true);
    try {
      const res = await api.generateRepurpose(slug, formats);
      setData(res);
      setOpen(formats[0]);
      // Anything this request did not finish is written by the next looks.
      if (draftsPending(res.drafts)) setTimeout(() => setPoll((n) => n + 1), POLL_MS);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't start the drafts.", "error");
    } finally {
      setGenerating(false);
    }
  };

  const header = (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <SparklesIcon className="-mt-3 size-4 text-brand" />
        <SectionTitle>Repurpose this session</SectionTitle>
      </div>
      {data && (
        <button
          type="button"
          onClick={() => setVoiceOpen((v) => !v)}
          className="-mt-3 text-[12.5px] font-medium text-brand hover:underline"
          aria-expanded={voiceOpen}
        >
          {data.brandVoiceSet ? "Brand voice: set · Edit" : "Set your brand voice"}
        </button>
      )}
    </div>
  );

  if (!data) {
    return (
      <Card className="mb-4 p-5">
        {header}
        <p className="text-[13px] text-ink-2">{loadError ?? "Loading the drafts…"}</p>
      </Card>
    );
  }

  const blocked = repurposeBlockedText(data.status);
  const byFormat = new Map(data.drafts.map((d) => [d.format, d]));
  const current = open ? byFormat.get(open) : undefined;
  const busyFormats = new Set(data.drafts.filter((d) => d.status === "queued" || d.status === "writing").map((d) => d.format));

  return (
    <Card className="mb-4 p-5">
      {header}
      <p className="mb-3 text-[12.5px] text-ink-3">
        Turn what was said into drafts for your blog, newsletter and social posts. The AI writes from this session&apos;s
        transcript and Q&amp;A only. Read each draft, edit it, and mark it reviewed before you copy or download it.
        {data.source === "notes" && " This was a long session, so the drafts are written from notes on each part."}
      </p>

      {voiceOpen && (
        <BrandVoicePanel
          onSaved={(set) => {
            setData((d) => (d ? { ...d, brandVoiceSet: set } : d));
            setVoiceOpen(false);
          }}
          onClose={() => setVoiceOpen(false)}
        />
      )}

      {blocked ? (
        <p className="mb-3 text-[13px] text-ink-2">{blocked}</p>
      ) : (
        <div className="mb-4">
          <p className="mb-2 text-[12.5px] font-medium text-ink-2">Write drafts for</p>
          <div className="flex flex-wrap gap-1.5">
            {REPURPOSE_FORMATS.map((f) => {
              const on = picked.has(f.id);
              return (
                <label
                  key={f.id}
                  title={f.hint}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] ${
                    on ? "border-brand-line bg-brand-soft text-brand" : "border-line text-ink-2 hover:text-ink"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() =>
                      setPicked((p) => {
                        const next = new Set(p);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })
                    }
                  />
                  {f.label}
                  {byFormat.get(f.id)?.status === "ready" && <span className="text-[11px] text-ink-3">· written</span>}
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={generating || picked.size === 0}
              onClick={() => void generate(REPURPOSE_FORMATS.map((f) => f.id).filter((id) => picked.has(id)))}
            >
              {generating ? <Spinner className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
              {generating ? "Writing…" : "Write drafts"}
            </Button>
            <span className="text-[12px] text-ink-3">
              Each draft takes up to a minute and counts towards this month&apos;s AI allowance. Writing one again
              replaces it.
            </span>
          </div>
        </div>
      )}

      {data.drafts.length > 0 && (
        <div className="border-t border-line pt-3">
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Drafts">
            {data.drafts.map((d) => (
              <button
                key={d.format}
                type="button"
                role="tab"
                aria-selected={open === d.format}
                onClick={() => setOpen(d.format)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] ${
                  open === d.format ? "border-brand-line bg-brand-soft text-brand" : "border-line text-ink-2 hover:text-ink"
                }`}
              >
                {busyFormats.has(d.format) && <Spinner className="size-3" />}
                {formatLabel(d.format)}
              </button>
            ))}
          </div>
          {current && (
            <DraftEditor
              key={`${current.format}:${current.generatedAt ?? ""}`}
              slug={slug}
              topic={webinar.topic}
              draft={current}
              canRegenerate={!blocked}
              regenerating={generating}
              onChanged={setData}
              onRegenerate={() => void generate([current.format])}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.bold ? <strong key={i}>{p.text}</strong> : p.italic ? <em key={i}>{p.text}</em> : <Fragment key={i}>{p.text}</Fragment>,
      )}
    </>
  );
}

/** The draft as it will read: headings, lists and paragraphs, no HTML from the model. */
function Preview({ text, plain }: { text: string; plain: boolean }) {
  return (
    <div className="grid max-h-[32rem] gap-2 overflow-y-auto rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-[13.5px] leading-relaxed text-ink">
      {markdownBlocks(text, plain).map((b, i) => {
        if (b.kind === "heading") {
          const size = b.level === 1 ? "text-[18px]" : b.level === 2 ? "text-[15.5px]" : "text-[14px]";
          return (
            <p key={i} className={`${size} mt-1 font-semibold`}>
              <InlineText parts={b.text} />
            </p>
          );
        }
        if (b.kind === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i} className={`${b.ordered ? "list-decimal" : "list-disc"} grid gap-1 pl-5`}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <InlineText parts={it} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            <InlineText parts={b.text} />
          </p>
        );
      })}
    </div>
  );
}

function DraftEditor({
  slug,
  topic,
  draft: d,
  canRegenerate,
  regenerating,
  onChanged,
  onRegenerate,
}: {
  slug: string;
  topic: string;
  draft: RepurposeDraft;
  canRegenerate: boolean;
  regenerating: boolean;
  onChanged: (res: RepurposeResponse) => void;
  onRegenerate: () => void;
}) {
  const { notify } = useToast();
  const [text, setText] = useState(d.markdown);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = text !== d.markdown;
  const pending = d.status === "queued" || d.status === "writing";
  const badge = draftBadge(d);
  const plain = isPlainFormat(d.format);
  const length = lengthNote(d.format, text);
  const canShare = d.reviewed && !dirty && d.markdown !== "";

  const save = async (reviewed: boolean, done: string) => {
    if (saving) return;
    setSaving(true);
    try {
      onChanged(await api.saveRepurpose(slug, d.format, text, reviewed));
      notify(done, "ok");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't save the draft.", "error");
    } finally {
      setSaving(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${formatLabel(d.format)} copied.`, "ok");
    } catch {
      notify("Couldn't reach the clipboard.", "info");
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-medium text-ink">{formatLabel(d.format)}</span>
        <Badge tone={badge.tone}>{badge.text}</Badge>
        {d.edited && <Badge tone="brand">Edited</Badge>}
        {d.markdown && (
          <div className="ml-auto inline-flex rounded-md border border-line p-0.5" role="group" aria-label="View">
            {(["preview", "edit"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-0.5 text-[12px] ${mode === m ? "bg-brand-soft text-brand" : "text-ink-2 hover:text-ink"}`}
              >
                {m === "preview" ? "Preview" : "Edit"}
              </button>
            ))}
          </div>
        )}
      </div>

      {pending && (
        <p className="text-[13px] text-ink-2">
          <Spinner className="size-3.5" />{" "}
          {d.markdown
            ? "Writing a new draft… the one below stays until it's ready."
            : "Writing the draft… this takes up to a minute. You can leave this page and come back."}
        </p>
      )}
      {d.status === "failed" && <p className="text-[13px] text-live">{draftFailedText(d.reason)}</p>}

      {d.markdown &&
        (mode === "edit" ? (
          <textarea
            className="field min-h-72 resize-y py-2 font-mono text-[12.5px] leading-relaxed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`${formatLabel(d.format)} draft`}
          />
        ) : (
          <Preview text={text} plain={plain} />
        ))}
      {d.markdown && length && (
        <p className={`text-[12px] ${length.over ? "text-live" : "text-ink-3"}`}>{length.text}</p>
      )}
      {d.markdown && (
        <p className="text-[12px] text-ink-3">
          Written by AI from the session. Check every fact, name and number before you publish, and fill in
          anything in [square brackets].
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {dirty && (
          <>
            <Button type="button" size="sm" disabled={saving} onClick={() => void save(d.reviewed, "Draft saved.")}>
              {saving && <Spinner className="size-3.5" />}
              Save changes
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setText(d.markdown)}>
              Discard
            </Button>
          </>
        )}
        {d.markdown && !d.reviewed && (
          <Button
            type="button"
            variant={dirty ? "secondary" : "primary"}
            size="sm"
            disabled={saving}
            onClick={() => void save(true, "Marked as reviewed.")}
          >
            {dirty ? "Save and mark as reviewed" : "Mark as reviewed"}
          </Button>
        )}
        {d.markdown && (
          <>
            <Button type="button" variant="secondary" size="sm" disabled={!canShare} onClick={() => void copy()}>
              <CopyIcon className="size-3.5" />
              Copy
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canShare}
              onClick={() => downloadMarkdown(draftFileName(d.format, topic), text)}
            >
              Download .md
            </Button>
          </>
        )}
        {canRegenerate && !pending && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={regenerating}
            onClick={() => (d.edited || dirty ? setConfirm(true) : onRegenerate())}
          >
            {d.status === "failed" && !d.markdown ? "Try again" : "Write it again"}
          </Button>
        )}
        {d.reviewed && !dirty && (
          <button
            type="button"
            className="text-[12px] text-ink-3 hover:text-ink hover:underline"
            disabled={saving}
            onClick={() => void save(false, "Review mark taken off.")}
          >
            Not reviewed after all
          </button>
        )}
      </div>
      {d.markdown && !canShare && (
        <p className="text-[12px] text-ink-3">
          {dirty
            ? "Save your changes to copy or download them."
            : "Mark it as reviewed to copy or download it: until you have read it, it is the AI's draft, not your words."}
        </p>
      )}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onRegenerate();
        }}
        title="Write this draft again?"
        body="The new draft replaces this one, and your edits go with it."
        confirmLabel="Write it again"
      />
    </div>
  );
}

const EMPTY_VOICE: BrandVoice = { tone: "", audience: "", doWords: "", dontWords: "", sample: "" };

/* The host's brand voice: on the account, applied to every draft from now on. Every field is
 * optional; it shapes how a draft sounds, never what it says. */
function BrandVoicePanel({ onSaved, onClose }: { onSaved: (set: boolean) => void; onClose: () => void }) {
  const { notify } = useToast();
  const [voice, setVoice] = useState<BrandVoice | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .brandVoice()
      .then((v) => {
        if (!cancelled) setVoice(v);
      })
      .catch(() => {
        if (!cancelled) setVoice(EMPTY_VOICE);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!voice) {
    return (
      <div className="mb-4 rounded-lg border border-line p-4 text-[13px] text-ink-2">
        <Spinner className="size-3.5" /> Loading your brand voice…
      </div>
    );
  }
  const set = (patch: Partial<BrandVoice>) => setVoice({ ...voice, ...patch });
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveBrandVoice({ ...voice, updatedAt: undefined });
      const any = [saved.tone, saved.audience, saved.doWords, saved.dontWords, saved.sample].some((s) => s.trim());
      notify("Brand voice saved. New drafts will use it.", "ok");
      onSaved(any);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't save the brand voice.", "error");
    } finally {
      setSaving(false);
    }
  };
  const field = "grid gap-1 text-[12.5px] font-medium text-ink-2";
  return (
    <div className="mb-4 grid gap-3 rounded-lg border border-line p-4">
      <p className="text-[12.5px] text-ink-3">
        How your drafts should sound. Used for every draft you write from now on. Leave anything blank to skip it.
      </p>
      <label className={field}>
        Tone
        <input
          className="field"
          maxLength={300}
          placeholder="e.g. warm, practical, a little playful"
          value={voice.tone}
          onChange={(e) => set({ tone: e.target.value })}
        />
      </label>
      <label className={field}>
        Who you write for
        <input
          className="field"
          maxLength={300}
          placeholder="e.g. working women in their 30s starting to invest"
          value={voice.audience}
          onChange={(e) => set({ audience: e.target.value })}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          Words and phrases to use
          <input
            className="field"
            maxLength={500}
            placeholder="e.g. step by step, your money"
            value={voice.doWords}
            onChange={(e) => set({ doWords: e.target.value })}
          />
        </label>
        <label className={field}>
          Words to avoid
          <input
            className="field"
            maxLength={500}
            placeholder="e.g. guaranteed, hustle, hack"
            value={voice.dontWords}
            onChange={(e) => set({ dontWords: e.target.value })}
          />
        </label>
      </div>
      <label className={field}>
        A sample of your writing (optional)
        <textarea
          className="field min-h-24 resize-y py-2"
          maxLength={3000}
          placeholder="Paste a post or email you wrote. The AI copies its style, never its facts."
          value={voice.sample}
          onChange={(e) => set({ sample: e.target.value })}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Spinner className="size-3.5" />}
          Save brand voice
        </Button>
      </div>
    </div>
  );
}

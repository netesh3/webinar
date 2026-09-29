"use client";

import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { CRMStarterTemplate } from "@/lib/api-types";
import { CategoryPill } from "./wa-kit";

/* The Templates tab's starter set: four messages written for webinars, with the cover as
 * the picture, a Join / Watch replay button that opens the person's own link, and quick
 * replies this app acts on. One press submits the missing ones to Meta for approval,
 * which usually takes minutes and can take a day. */
export function StarterTemplates({
  connected,
  onCreated,
  onUse,
  onItems,
}: {
  connected: boolean;
  onCreated: () => void;
  /** From a message's wording dialog: an approved starter is applied to that message.
   *  Absent on the templates library, which only submits and lists them. */
  onUse?: (template: CRMStarterTemplate) => void | Promise<unknown>;
  onItems?: (templates: CRMStarterTemplate[]) => void;
}) {
  const { notify } = useToast();
  const [items, setItems] = useState<CRMStarterTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [using, setUsing] = useState<string | null>(null);

  const show = useCallback(
    (next: CRMStarterTemplate[]) => {
      setItems(next);
      onItems?.(next);
    },
    [onItems],
  );

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmStarterTemplates()
      .then((r) => {
        if (!cancelled) show(r.templates);
      })
      .catch(() => {
        if (!cancelled) show([]);
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  async function create() {
    setBusy(true);
    try {
      const r = await engageApi.createCrmStarterTemplates();
      show(r.templates);
      const failed = r.templates.filter((t) => t.error);
      notify(
        failed.length
          ? `Submitted, but Meta refused ${failed.length}: ${failed[0].error}`
          : "Submitted to Meta. Approval usually takes a few minutes.",
        failed.length ? "error" : "ok",
      );
      onCreated();
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not submit them.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!items || items.length === 0) return null;
  const missing = items.filter((t) => !t.status).length;
  const ready =
    Boolean(onUse) && items.every((t) => t.status === "APPROVED" && !t.error);

  async function applyOne(t: CRMStarterTemplate) {
    if (!onUse || using) return;
    setUsing(t.name);
    try {
      await onUse(t);
    } finally {
      setUsing(null);
    }
  }

  return (
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-[15px] font-semibold">Starter templates</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-2">
            {ready ? (
              "These are approved. Use one on this message."
            ) : (
              <>
                Written for webinars: your cover as the picture, a button that opens
                each person&apos;s own link, and replies this app acts on —
                &ldquo;Can&apos;t make it&rdquo; tags them for the replay,
                &ldquo;Tell me more&rdquo; marks a hot lead.
              </>
            )}
          </p>
        </div>
        {missing > 0 && (
          <Button size="sm" onClick={create} disabled={busy || !connected}>
            {busy && <Spinner className="size-3.5" />}
            Submit {missing === items.length ? "all" : missing} to Meta
          </Button>
        )}
      </div>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {items.map((t) => {
          const approved = t.status === "APPROVED" && !t.error;
          const canUse = Boolean(onUse) && approved;
          return (
            <li key={t.name}>
              {canUse ? (
                <button
                  type="button"
                  onClick={() => void applyOne(t)}
                  disabled={using !== null}
                  className="w-full rounded-lg border border-line px-3 py-2.5 text-left hover:border-brand hover:bg-brand-soft disabled:opacity-60"
                >
                  <StarterBody template={t} />
                  <span className="mt-2 inline-flex h-7 items-center rounded-md bg-brand px-2.5 text-[12px] font-medium text-white">
                    {using === t.name ? "Using…" : "Use"}
                  </span>
                </button>
              ) : (
                <div className="rounded-lg border border-line px-3 py-2.5">
                  <StarterBody template={t} />
                  {onUse && (!t.status || t.error) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      onClick={() => void create()}
                      disabled={busy || !connected}
                    >
                      {busy && <Spinner className="size-3.5" />}
                      Submit
                    </Button>
                  )}
                  {onUse && t.status && !approved && !t.error && (
                    <p className="mt-2 text-[11.5px] text-ink-3">
                      You can use this once Meta approves it.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function StarterBody({ template: t }: { template: CRMStarterTemplate }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
        {t.use}
        <CategoryPill category={t.category} />
        <span className="ml-auto text-[11px] font-normal">
          {t.error ? (
            <span className="text-live" title={t.error}>
              Refused
            </span>
          ) : t.status === "APPROVED" ? (
            <span className="text-ok">Approved</span>
          ) : t.status ? (
            <span className="text-warn">{t.status.toLowerCase()} at Meta</span>
          ) : (
            <span className="text-ink-3">Not submitted</span>
          )}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{t.body}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {t.buttons.map((b) => (
          <span
            key={b.text}
            className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-[#027eb5]"
          >
            {b.type === "URL" ? "↗" : "↩"} {b.text}
          </span>
        ))}
      </div>
    </>
  );
}

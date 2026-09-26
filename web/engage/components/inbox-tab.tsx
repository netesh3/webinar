"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Select, Spinner } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { Button, Card, Empty } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  FeatureCRMNotes,
  FeatureCRMTags,
  InboxAll,
  InboxDone,
  InboxNeedsReply,
  type CRMInboxResponse,
  type CRMInboxThread,
  type CRMTag,
  type CRMTemplate,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { Thread } from "./crm-screen";

/* Hosting → Messages: the WhatsApp conversations, with the ones waiting on you first.
 *
 * "Needs reply" is the default view because it is the only question a host opens this
 * with. A conversation leaves it when somebody answers — here, or on the phone when the
 * number is on the WhatsApp Business app (Coexistence) — or when it is marked done. A
 * new message from them puts it back.
 */

const POLL_MS = 20_000;

const VIEWS = [
  { id: InboxNeedsReply, label: "Needs reply" },
  { id: InboxAll, label: "All" },
  { id: InboxDone, label: "Done" },
] as const;

export function HostMessagesTab({
  initialContact = "",
  initialWebinar = "",
}: {
  initialContact?: string;
  initialWebinar?: string;
}) {
  const { account } = useSession();
  const { notify } = useToast();
  const features = account?.features ?? [];
  const tagsOn = features.includes(FeatureCRMTags);
  const notesOn = features.includes(FeatureCRMNotes);

  // Opening a named person from People shows every conversation, not just waiting ones.
  const [view, setView] = useState<string>(initialContact ? InboxAll : InboxNeedsReply);
  const [webinar, setWebinar] = useState(initialWebinar);
  const [data, setData] = useState<CRMInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialContact || null);
  const [tick, setTick] = useState(0);
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tags, setTags] = useState<CRMTag[] | null>(null);
  const [marking, setMarking] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmInbox(view, webinar)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your messages.");
      });
    return () => {
      cancelled = true;
    };
  }, [view, webinar, tick]);

  // Re-read while the tab is being looked at, so a reply shows up without a reload.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmTemplates()
      .then((res) => {
        if (!cancelled) setTemplates(res.templates);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError ? e.message : "Could not load your WhatsApp templates.",
        );
      });
    if (tagsOn)
      engageApi
        .crmTags()
        .then((res) => {
          if (!cancelled) setTags(res.tags);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tagsOn]);

  async function refreshTemplates() {
    setSyncing(true);
    try {
      const res = await engageApi.crmTemplates(true);
      setTemplates(res.templates);
      setTemplatesError(null);
    } catch (e: unknown) {
      notify(e instanceof ApiError ? e.message : "Could not reach WhatsApp.", "error");
    } finally {
      setSyncing(false);
    }
  }

  const selected = data?.threads.find((t) => t.contact.id === selectedId) ?? null;

  async function markDone(done: boolean) {
    if (!selectedId) return;
    setMarking(true);
    try {
      await engageApi.setCrmDone(selectedId, done);
      notify(done ? "Marked done." : "Reopened.", "ok");
      if (done && view === InboxNeedsReply) setSelectedId(null);
      refresh();
    } catch (e: unknown) {
      notify(e instanceof ApiError ? e.message : "Could not change that.", "error");
    } finally {
      setMarking(false);
    }
  }

  if (error && !data) return <Empty title={error} />;
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  if (!data.whatsappConnected && data.counts.all === 0) {
    return (
      <Empty
        title="Connect WhatsApp to see replies here"
        hint="When people answer your confirmations, reminders and follow-ups, their replies land here and you can answer from this tab."
        action={
          <Link href="/account" className="font-medium text-brand hover:underline">
            Account settings
          </Link>
        }
      />
    );
  }

  const counts: Record<string, number> = {
    [InboxNeedsReply]: data.counts.needsReply,
    [InboxAll]: data.counts.all,
    [InboxDone]: data.counts.done,
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                view === v.id
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-line text-ink-2 hover:border-line-strong"
              }`}
            >
              {v.label} <span className="tabular-nums opacity-70">{counts[v.id]}</span>
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <Select label="Webinar" value={webinar} onChange={setWebinar}>
            <option value="">All webinars</option>
            {data.webinars.map((w) => (
              <option key={w.id} value={w.id}>
                {w.topic}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {data.coexistence && (
        <p className="text-[12px] text-ink-3">
          Replies you type in the WhatsApp Business app on your phone show up here too.
        </p>
      )}

      {data.threads.length === 0 && !selectedId ? (
        <Empty
          title={view === InboxNeedsReply ? "You're all caught up" : "No conversations here"}
          hint={
            view === InboxNeedsReply
              ? "Nobody is waiting on a reply. New ones show up here, and on the bell."
              : undefined
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
          <Card
            className={`divide-y divide-line overflow-hidden p-0 ${selectedId ? "hidden lg:block" : ""}`}
          >
            {data.threads.map((t) => (
              <InboxRow
                key={t.contact.id}
                thread={t}
                active={t.contact.id === selectedId}
                onSelect={() => setSelectedId(t.contact.id)}
              />
            ))}
            {data.threads.length === 0 && (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">
                Nothing in this view.
              </div>
            )}
          </Card>

          <div className={selectedId ? "grid gap-2" : "hidden lg:block"}>
            {selectedId ? (
              <>
                <div className="flex items-center justify-end gap-2">
                  {view !== InboxDone ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => markDone(true)}
                      disabled={marking}
                    >
                      Mark done
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => markDone(false)}
                      disabled={marking}
                    >
                      Reopen
                    </Button>
                  )}
                </div>
                <Thread
                  key={selectedId}
                  contactId={selectedId}
                  fallback={selected?.contact ?? null}
                  tick={tick}
                  allTags={tagsOn ? (tags ?? []) : null}
                  notesOn={notesOn}
                  templates={templates}
                  templatesError={templatesError}
                  syncing={syncing}
                  onRefreshTemplates={refreshTemplates}
                  onChanged={refresh}
                  onBack={() => setSelectedId(null)}
                />
              </>
            ) : (
              <Card className="grid place-items-center px-6 py-20 text-center">
                <p className="text-[13.5px] text-ink-2">Pick a conversation to read it.</p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InboxRow({
  thread: t,
  active,
  onSelect,
}: {
  thread: CRMInboxThread;
  active: boolean;
  onSelect: () => void;
}) {
  const c = t.contact;
  const name = c.name || c.phone || c.email || "Unknown";
  const m = t.lastMessage;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full px-4 py-3 text-left transition ${
        active ? "bg-brand-soft/50" : "hover:bg-surface-2"
      }`}
    >
      <div className="flex items-center gap-2">
        {t.needsReply && <span className="size-2 shrink-0 rounded-full bg-brand" aria-label="Needs reply" />}
        <span className={`truncate text-[13px] ${t.needsReply ? "font-semibold" : "font-medium"}`}>
          {name}
        </span>
        {m && (
          <span className="ml-auto shrink-0 text-[11px] text-ink-3">
            {formatRelative(m.createdAt, new Date())}
          </span>
        )}
      </div>
      {m && (
        <p className="mt-0.5 truncate text-[12px] text-ink-2">
          {m.direction === "out" ? "You: " : ""}
          {m.body || m.templateName || (m.kind ? `[${m.kind}]` : "")}
        </p>
      )}
      {t.webinar && <p className="mt-0.5 truncate text-[11px] text-ink-3">{t.webinar}</p>}
    </button>
  );
}

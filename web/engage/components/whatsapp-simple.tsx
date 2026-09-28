"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type {
  CRMMergeField,
  CRMRecipe,
  CRMRecipesResponse,
  CRMReminder,
  CRMSetup,
  CRMTemplate,
} from "@/lib/api-types";
import { exampleFor, renderTemplate } from "./crm-templates";
import { StarterTemplates } from "./starter-templates";
import { Switch } from "./wa-kit";
import { EVERYONE_MESSAGES, MessageEditor } from "./wa-messages";
import { KeywordsDialog } from "./automations";

/* The WhatsApp page, simplified (docs/mockups/simple/whatsapp.html): one page, three parts.
 *
 *   1. The connection, as one line once it works (the checklist until then).
 *   2. Sent to everyone who registers: the confirmation, reminder and replay, shown as the
 *      attendee reads them, each with Edit.
 *   3. Automations: each a sentence — "When … → …" — with a switch.
 *
 * The builders (sequences, bots, broadcasts) and the full template list stay reachable
 * from links; nothing a host set up is lost. */

export function WhatsAppSimple({
  setup,
  templates,
  onOpen,
  onTemplatesChanged,
}: {
  setup: CRMSetup | null;
  templates: CRMTemplate[] | null;
  /** Opens one of the full views: setup, templates, sequences, bots, broadcasts. */
  onOpen: (
    view: "setup" | "templates" | "sequences" | "bots" | "broadcasts",
  ) => void;
  onTemplatesChanged: () => void;
}) {
  const { notify } = useToast();
  const [reminders, setReminders] = useState<CRMReminder[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [recipes, setRecipes] = useState<CRMRecipesResponse | null>(null);
  const [editing, setEditing] = useState<
    (typeof EVERYONE_MESSAGES)[number] | null
  >(null);
  const [writing, setWriting] = useState(false);
  const [keywords, setKeywords] = useState<CRMRecipe | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([engageApi.crmReminders(), engageApi.crmRecipes()])
      .then(([r, rc]) => {
        if (cancelled) return;
        setReminders(r.reminders);
        setFields(r.fields);
        setRecipes(rc);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const connected = Boolean(setup?.connected);

  async function toggleRecipe(r: CRMRecipe, on: boolean) {
    try {
      const res = await engageApi.saveCrmRecipe(r.id, {
        active: on,
        template: on ? r.template : undefined,
        language: on ? r.language : undefined,
        params: on ? r.params : undefined,
        delayMin: on ? r.delayMin : undefined,
        keywords: r.kind === "keywords" ? r.keywords : undefined,
        words: r.kind === "hot_leads" ? r.words : undefined,
      });
      setRecipes(res);
      notify(on ? "On." : "Off.", "ok");
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that.",
        "error",
      );
    }
  }

  const followups = (recipes?.recipes ?? []).filter(
    (r) => r.kind === "followup",
  );
  const followOn = followups.filter((r) => r.active).length;
  const hot = recipes?.recipes.find((r) => r.kind === "hot_leads");
  const kw = recipes?.recipes.find((r) => r.kind === "keywords");

  return (
    <div className="grid gap-6">
      {/* 1. Connection */}
      {connected ? (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span
            className="size-2.5 shrink-0 rounded-full bg-ok ring-4 ring-ok/15"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-ink">
              Connected · {setup?.displayPhone || "your number"}
              {setup?.verifiedName ? ` · ${setup.verifiedName}` : ""}
            </p>
            <p className="text-[12px] text-ink-3">
              Messages come from your number and Meta bills your account ·{" "}
              {setup?.optedInContacts ?? 0} people can get WhatsApp
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpen("setup")}
            className="text-[12.5px] font-medium text-brand hover:underline"
          >
            Settings
          </button>
        </Card>
      ) : (
        <Card className="flex flex-wrap items-center gap-3 border-brand-line bg-brand-soft/40 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-ink">
              Connect your WhatsApp Business number
            </p>
            <p className="text-[12px] text-ink-2">
              Confirmations, reminders and follow-ups then go out from your own
              number.
            </p>
          </div>
          <Button size="sm" onClick={() => onOpen("setup")}>
            Connect
          </Button>
        </Card>
      )}

      {/* 2. Sent to everyone who registers */}
      <section className="grid gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">
            Sent to everyone who registers
          </h2>
          <p className="text-[12.5px] text-ink-2">
            For every webinar with WhatsApp on. Edit the wording any time.
          </p>
        </div>
        <Card className="divide-y divide-line p-0">
          {EVERYONE_MESSAGES.map((m) => {
            const r = reminders?.find((x) => x.kind === m.kind);
            const t = (templates ?? []).find(
              (x) => x.name === r?.template && x.language === r?.language,
            );
            return (
              <div
                key={m.kind}
                className="grid items-center gap-3 px-4 py-3.5 md:grid-cols-[10rem_minmax(0,1fr)_auto]"
              >
                <div>
                  <p className="text-[13.5px] font-semibold text-ink">
                    {m.title}
                  </p>
                  <p className="text-[11.5px] text-ink-3">{m.when}</p>
                </div>
                <div className="rounded-xl bg-[#efeae2] p-2">
                  {t ? (
                    <div className="max-w-xl rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[#111] shadow-sm">
                      {renderTemplate(
                        t.body ?? "",
                        (r?.params ?? []).map((p) => exampleFor(fields, p)),
                      )}
                      {(t.buttons ?? []).length > 0 && (
                        <span className="mt-1 flex justify-center gap-4 border-t border-black/5 pt-1 text-[12px] font-medium text-[#027eb5]">
                          {t.buttons.map((b) => (
                            <span key={b.text}>
                              {b.type === "URL" ? "↗" : "↩"} {b.text}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="px-2 py-1.5 text-[12.5px] text-ink-3">
                      {reminders === null
                        ? "…"
                        : "Not sent on WhatsApp — email only."}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(m)}
                  disabled={!connected || !templates}
                >
                  {t ? "Edit" : "Set up"}
                </Button>
              </div>
            );
          })}
        </Card>
      </section>

      {/* 3. Automations */}
      <section className="grid gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Automations</h2>
            <p className="text-[12.5px] text-ink-2">
              Switch on what you want WhatsApp to do for you.
            </p>
          </div>
        </div>
        <Card className="divide-y divide-line p-0">
          <Rule
            when="a webinar ends"
            then="message each group"
            hint={`Offer to the highly engaged, the replay to who missed it… · pick groups on each webinar's Follow up tab · ${followOn} of ${followups.length || 5} on`}
            right={
              <span className="text-[12px] text-ink-3">
                {followOn ? "On" : "Off"}
              </span>
            }
          />
          {hot && (
            <Rule
              when="a reply mentions price, program or 1:1"
              then={
                <>
                  tag <b>Hot lead</b>
                </>
              }
              hint={hot.hint}
              right={
                <Switch
                  checked={hot.active}
                  onChange={(v) => void toggleRecipe(hot, v)}
                  label="Tag hot leads"
                  disabled={!connected}
                />
              }
            />
          )}
          {kw && (
            <Rule
              when={
                <>
                  someone sends{" "}
                  {kw.keywords?.length ? (
                    kw.keywords.map((k) => <b key={k.word}>{k.word} </b>)
                  ) : (
                    <>
                      <b>PRICE</b> or <b>REPLAY</b>
                    </>
                  )}
                </>
              }
              then="reply straight away"
              hint={kw.hint}
              right={
                kw.configured ? (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setKeywords(kw)}
                      className="text-[12px] font-medium text-brand hover:underline"
                    >
                      Edit
                    </button>
                    <Switch
                      checked={kw.active}
                      onChange={(v) => void toggleRecipe(kw, v)}
                      label="Keyword replies"
                      disabled={!connected}
                    />
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setKeywords(kw)}
                    disabled={!connected}
                  >
                    Set up
                  </Button>
                )
              }
            />
          )}
        </Card>
        <p className="text-[12px] text-ink-3">
          One message to a group, once?{" "}
          <button
            type="button"
            onClick={() => onOpen("broadcasts")}
            className="font-medium text-brand hover:underline"
          >
            Send a message now
          </button>{" "}
          · Something custom?{" "}
          <button
            type="button"
            onClick={() => onOpen("sequences")}
            className="font-medium text-brand hover:underline"
          >
            Sequences
          </button>{" "}
          and{" "}
          <button
            type="button"
            onClick={() => onOpen("bots")}
            className="font-medium text-brand hover:underline"
          >
            bots
          </button>
        </p>
      </section>

      {editing && templates && (
        <MessageEditor
          kind={editing.kind}
          title={editing.title}
          current={reminders?.find((r) => r.kind === editing.kind)}
          templates={templates}
          fields={fields}
          onClose={() => setEditing(null)}
          onSaved={(all) => setReminders(all)}
          onWriteOwn={() => {
            setEditing(null);
            setWriting(true);
          }}
        />
      )}
      {writing && (
        <Modal
          open
          onClose={() => setWriting(false)}
          size="lg"
          title="Write your own wording"
        >
          <div className="grid gap-3">
            <Alert tone="info">
              Meta approves every message before it can be sent, usually in
              minutes. Start from these — written for webinars, with a Join /
              Watch replay button and replies this app acts on — or write any
              wording in{" "}
              <a
                href="https://business.facebook.com/wa/manage/message-templates/"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                WhatsApp Manager
              </a>{" "}
              and it shows up here.
            </Alert>
            <StarterTemplates
              connected={connected}
              onCreated={() => {
                onTemplatesChanged();
                refresh();
              }}
            />
          </div>
        </Modal>
      )}
      {keywords && (
        <KeywordsDialog
          recipe={keywords}
          onClose={() => setKeywords(null)}
          onSaved={(d) => {
            setRecipes(d);
            setKeywords(null);
          }}
        />
      )}
      {!setup && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
      <p className="text-[12px] text-ink-3">
        <Link
          href="/host/crm?view=templates"
          onClick={(e) => {
            e.preventDefault();
            onOpen("templates");
          }}
          className="hover:text-ink"
        >
          All your wording at Meta →
        </Link>
      </p>
    </div>
  );
}

function Rule({
  when,
  then,
  hint,
  right,
}: {
  when: React.ReactNode;
  then: React.ReactNode;
  hint?: string;
  right: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] text-ink">
          <span className="text-ink-3">When</span> {when}{" "}
          <span className="text-ink-3">→</span> {then}
        </p>
        {hint && <p className="mt-0.5 text-[12px] text-ink-3">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { MESSAGES_HREF } from "../slots";
import { Alert, Modal, Spinner } from "@/components/controls";
import { MaterialIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type {
  CRMDrip,
  CRMMergeField,
  CRMRecipe,
  CRMRecipesResponse,
  CRMSetup,
  CRMTag,
  CRMTemplate,
  MessageSlot,
  MessageTiming,
} from "@/lib/api-types";
import { KeywordsDialog } from "./automations";
import { RuleBuilder } from "./rule-builder";
import { SlotEditor } from "./slot-editor";
import { StarterTemplates } from "./starter-templates";
import { WhatsAppAuto } from "./whatsapp-auto";
import { WhatsAppMetrics } from "./whatsapp-metrics";
import { WhatsAppReplies } from "./whatsapp-replies";
import { minutesOf, timingForSave } from "./message-timing";

/* The WhatsApp page (docs/mockups/simple/whatsapp.html, variant B).
 *
 * The header, the numbers, what goes out automatically, and automatic replies.
 * Switches, wording and timing write crm_message_defaults only. */

export function WhatsAppSimple({
  setup,
  templates,
  onOpen,
  onTemplatesChanged,
}: {
  setup: CRMSetup | null;
  templates: CRMTemplate[] | null;
  onOpen: (view: "setup" | "templates" | "broadcasts") => void;
  onTemplatesChanged: () => void;
}) {
  const { notify } = useToast();
  const [slots, setSlots] = useState<MessageSlot[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [recipes, setRecipes] = useState<CRMRecipesResponse | null>(null);
  const [rules, setRules] = useState<CRMDrip[]>([]);
  const [tags, setTags] = useState<CRMTag[]>([]);
  const [needsReply, setNeedsReply] = useState(0);
  const [editing, setEditing] = useState<{ slot: MessageSlot; title: string } | null>(
    null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [keywords, setKeywords] = useState<CRMRecipe | null>(null);
  const [building, setBuilding] = useState(false);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      engageApi.crmMessageDefaults(),
      engageApi.crmReminders().catch(() => null),
      engageApi.crmRecipes().catch(() => null),
      engageApi.crmDrips().catch(() => null),
      engageApi.crmSummary().catch(() => null),
    ])
      .then(([defaults, reminders, rc, drips, summary]) => {
        if (cancelled) return;
        setSlots(defaults.slots.map(normalizeSlot));
        setFields(reminders?.fields ?? []);
        setRecipes(rc);
        setRules((drips?.drips ?? []).filter((x) => !x.recipe));
        setTags(drips?.tags ?? []);
        setNeedsReply(summary?.needsReply ?? 0);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const connected = Boolean(setup?.connected);

  async function saveSlot(next: MessageSlot) {
    setBusyKind(next.kind);
    setEditError(null);
    try {
      const res = await engageApi.setCrmMessageDefaults({
        slots: [{ ...next, timing: timingForSave(next.timing) }],
      });
      setSlots(res.slots.map(normalizeSlot));
      return true;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not save that.";
      if (editing) setEditError(msg);
      notify(msg, "error");
      return false;
    } finally {
      setBusyKind(null);
    }
  }

  async function toggle(slot: MessageSlot, enabled: boolean) {
    const ok = await saveSlot({ ...slot, enabled });
    if (ok) notify(enabled ? "On." : "Off.", "ok");
  }

  async function saveTiming(slot: MessageSlot, timing: MessageTiming) {
    const ok = await saveSlot({ ...slot, timing });
    if (ok) notify("Saved.", "ok");
  }

  async function toggleRule(d: CRMDrip, active: boolean) {
    try {
      const res = await engageApi.updateCrmDrip(d.id, {
        name: d.name,
        trigger: d.trigger,
        webinarId: d.webinarId,
        tagId: d.tagId || undefined,
        tiers: d.tiers,
        match: d.match,
        active,
        steps: d.steps,
      });
      setRules((prev) => prev.map((x) => (x.id === d.id ? res.drip : x)));
      notify(active ? "On." : "Off.", "ok");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not change that.", "error");
    }
  }

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
      notify(e instanceof ApiError ? e.message : "Could not change that.", "error");
    }
  }

  const hot = recipes?.recipes.find((r) => r.kind === "hot_leads");
  const kw = recipes?.recipes.find((r) => r.kind === "keywords");

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">WhatsApp</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            Your attendees get these on WhatsApp, from your own number — for every webinar.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={MESSAGES_HREF}
            className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-2"
          >
            <MaterialIcon name="forum" className="mr-1.5 !text-[17px]" />
            Open inbox
            {needsReply > 0 && (
              <span className="ml-1.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[11px] font-semibold text-white">
                {needsReply}
              </span>
            )}
          </Link>
          <Button onClick={() => onOpen("broadcasts")}>
            <MaterialIcon name="send" className="mr-1.5 !text-[17px]" />
            Send a message
          </Button>
        </div>
      </header>

      <WhatsAppMetrics setup={setup} onSettings={() => onOpen("setup")} />

      {slots === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <WhatsAppAuto
          slots={slots}
          templates={templates}
          fields={fields}
          connected={connected}
          busyKind={busyKind}
          onToggle={(slot, enabled) => void toggle(slot, enabled)}
          onTiming={(slot, timing) => void saveTiming(slot, timing)}
          onEdit={(slot, title) => {
            setEditError(null);
            setEditing({ slot, title });
          }}
        />
      )}

      <WhatsAppReplies
        rules={rules}
        hot={hot}
        keywords={kw}
        connected={connected}
        onToggleRule={(d, active) => void toggleRule(d, active)}
        onToggleRecipe={(r, on) => void toggleRecipe(r, on)}
        onKeywords={() => kw && setKeywords(kw)}
        onAdd={() => setBuilding(true)}
        onBroadcasts={() => onOpen("broadcasts")}
      />

      {editing && templates && (
        <SlotEditor
          slot={editing.slot}
          title={editing.title}
          templates={templates}
          fields={fields}
          busy={busyKind === editing.slot.kind}
          error={editError}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            void saveSlot(next).then((ok) => {
              if (ok) {
                notify(`${editing.title} saved.`, "ok");
                setEditing(null);
              }
            });
          }}
          onWriteOwn={() => {
            setEditing(null);
            setWriting(true);
          }}
        />
      )}
      {writing && (
        <Modal open onClose={() => setWriting(false)} size="lg" title="Write your own wording">
          <div className="grid gap-3">
            <Alert tone="info">
              Meta approves every message before it can be sent, usually in minutes.
              Start from these, or write any wording in WhatsApp Manager and it shows up here.
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
      {building && templates && (
        <RuleBuilder
          templates={templates}
          tags={tags}
          fields={fields}
          onClose={() => setBuilding(false)}
          onSaved={(d) => setRules((prev) => [d, ...prev])}
        />
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
      <p className="text-[12px] text-ink-3">
        <button
          type="button"
          onClick={() => onOpen("templates")}
          className="hover:text-ink"
        >
          All your wording at Meta →
        </button>
      </p>
    </div>
  );
}

/** after_end arrives as one number; the page keeps a list. */
function normalizeSlot(slot: MessageSlot): MessageSlot {
  return {
    ...slot,
    channels: slot.channels ?? [],
    params: slot.params ?? [],
    timing: { ...slot.timing, minutes: minutesOf(slot.timing) },
  };
}

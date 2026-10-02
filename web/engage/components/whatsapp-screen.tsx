"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  FeatureWhatsAppCRM,
  type CRMSetup,
  type CRMTag,
  type CRMTemplate,
} from "@/lib/api-types";
import { Broadcasts } from "./crm-broadcasts";
import { RemindersSettings } from "./crm-screen";
import { SetupChecklist } from "./crm-setup";
import { ScheduleMessagesTab } from "./messages/schedule-messages-tab";
import { WhatsAppFrame, type WhatsAppTab } from "./whatsapp-frame";
import { WhatsAppMetricsView } from "./whatsapp-metrics";
import { WhatsAppTemplates } from "./whatsapp-templates";
import { MESSAGES_HREF } from "../hrefs";
import {
  beginWhatsAppHome,
  beginWhatsAppMetrics,
  resetWhatsAppBoot,
} from "../whatsapp-boot";

/* The WhatsApp page: /host/crm. Metrics is the first tab. Chats is /host/messages.
 * Templates, Automations and Broadcasts are the other tabs. Setup stays on
 * ?view=setup. ?view=broadcasts is the Broadcasts tab, not a separate page.
 * A ?view= this page does not know, including the retired sequences and bots
 * builders, is Metrics. */

type Tab = WhatsAppTab | "number";

/** Views this page still opens. Anything else, including sequences and bots, is metrics. */
const KNOWN_VIEWS = new Set([
  "setup",
  "number",
  "templates",
  "automations",
  "broadcasts",
  "metrics",
  "chats",
]);

function fromView(v: string): Tab {
  if (v === "setup" || v === "number") return "number";
  if (v === "broadcasts") return "broadcasts";
  if (v === "templates") return "templates";
  if (v === "automations") return "automations";
  if (v === "chats") return "chats";
  return "metrics";
}

function frameTab(tab: Tab): WhatsAppTab | null {
  if (tab === "number") return null;
  return tab;
}

export function WhatsAppScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const viewParam = (search.get("view") ?? "").trim();
  const tab = fromView(viewParam);
  const [broadcastCount, setBroadcastCount] = useState<number | null>(null);
  const onBroadcastCount = useCallback((n: number) => setBroadcastCount(n), []);
  const canHost = account?.canHost ?? false;
  const tagsOn = (account?.features ?? []).includes(FeatureWhatsAppCRM);

  const go = useCallback(
    (view: string) => {
      router.replace(view ? `/host/crm?view=${view}` : "/host/crm");
    },
    [router],
  );

  /* A retired or unknown ?view= already renders as Metrics (fromView).
   * Drop the query so a refresh and the address bar stay on /host/crm.
   * Chats is the inbox route. */
  useEffect(() => {
    if (viewParam === "chats" || viewParam === "inbox") {
      router.replace(MESSAGES_HREF);
      return;
    }
    if (!viewParam || KNOWN_VIEWS.has(viewParam)) return;
    router.replace("/host/crm");
  }, [viewParam, router]);

  const [setup, setSetup] = useState<CRMSetup | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupTick, setSetupTick] = useState(0);
  const reloadSetup = useCallback(() => setSetupTick((n) => n + 1), []);

  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tags, setTags] = useState<CRMTag[] | null>(null);

  /* Setup, templates and the home bundle need the cookie, not the account
   * body. They start while the login check is still out. The page below still
   * waits to draw until that check says this is a host; a rejection throws
   * the answers away. */
  useEffect(() => {
    if (status === "anonymous") {
      resetWhatsAppBoot();
      return;
    }
    beginWhatsAppHome().catch(() => {});
    beginWhatsAppMetrics().catch(() => {});
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmSetup()
      .then((res) => {
        if (cancelled) return;
        setSetup(res);
        setSetupError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setSetupError(
            e instanceof ApiError
              ? e.message
              : "Could not work out what is left to set up.",
          );
      })
      .finally(() => {
        if (!cancelled) setSetupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setupTick]);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.templates);
        setTemplatesError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your WhatsApp templates.",
        );
      });
    engageApi
      .crmTags()
      .then((r) => !cancelled && setTags(r.tags))
      .catch(() => !cancelled && setTags([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshTemplates = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await engageApi.crmTemplates(true);
      setTemplates(res.templates);
      setTemplatesError(null);
      notify(
        res.templates.length === 1
          ? "1 template from WhatsApp."
          : `${res.templates.length} templates from WhatsApp.`,
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not reach WhatsApp.",
        "error",
      );
    } finally {
      setSyncing(false);
    }
  }, [notify]);

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }
  if (status === "anonymous" || !canHost) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">WhatsApp is for hosts</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Sign in with a hosting account to set up your number and automations.
        </p>
      </Card>
    );
  }

  const connected = Boolean(setup?.connected ?? account?.whatsapp?.connected);

  return (
    <WhatsAppFrame
      tab={frameTab(tab)}
      templateCount={templates?.length ?? null}
      broadcastCount={broadcastCount}
    >
      {tab === "number" && (
        <button
          type="button"
          onClick={() => go("")}
          className="justify-self-start text-[12.5px] text-ink-2 hover:text-ink"
        >
          ← WhatsApp
        </button>
      )}

      {tab === "metrics" && <WhatsAppMetricsView />}

      {tab === "templates" && (
        <WhatsAppTemplates
          templates={templates}
          onCreated={() => void refreshTemplates()}
        />
      )}

      {tab === "automations" && (
        <ScheduleMessagesTab
          accountDefaults
          reminderTimes={() => null}
          automation={(search.get("automation") ?? "").trim()}
          onAutomationClose={() =>
            router.replace("/host/crm?view=automations", { scroll: false })
          }
        />
      )}

      {tab === "broadcasts" && (
        <Broadcasts
          whatsappConnected={connected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          tags={tagsOn ? (tags ?? []) : null}
          onRefreshTemplates={refreshTemplates}
          onCount={onBroadcastCount}
        />
      )}

      {tab === "number" && (
        <SetupChecklist
          setup={setup}
          loading={setupLoading}
          error={setupError}
          onChanged={reloadSetup}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={refreshTemplates}
          remindersPane={
            <RemindersSettings
              templates={templates}
              templatesError={templatesError}
              syncing={syncing}
              onRefreshTemplates={refreshTemplates}
              onSaved={reloadSetup}
            />
          }
        />
      )}
    </WhatsAppFrame>
  );
}

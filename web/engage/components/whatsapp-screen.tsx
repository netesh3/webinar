"use client";

import Link from "next/link";
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
import { Automations, type BuildView } from "./automations";
import { Broadcasts } from "./crm-broadcasts";
import { RemindersSettings } from "./crm-screen";
import { SetupChecklist } from "./crm-setup";
import { WhatsAppSimple } from "./whatsapp-simple";

/* The WhatsApp page: /host/crm. One simple page (WhatsAppSimple) — connection, the
 * messages everyone gets, automations — linking to Settings and a one-off broadcast.
 * Wording opens in a drawer on this page. ?view=templates still lands here and opens
 * that drawer, so older links keep working. A ?view= this page does not know, including
 * the retired sequences and bots builders, is the simple page. */

/* "home" is the one simple page; the others are the full views it links to — the setup
 * checklist, the automations cards, and a broadcast — reached by link and by the
 * ?view= addresses that still exist, not by tabs. */
type Tab = "home" | "automations" | "number";
const LABELS: Record<Tab, string> = {
  home: "WhatsApp",
  automations: "All automations",
  number: "Settings",
};

/** Views this page still opens. Anything else, including sequences and bots, is home. */
const KNOWN_VIEWS = new Set([
  "setup",
  "number",
  "templates",
  "automations",
  "broadcasts",
]);

function fromView(v: string): { tab: Tab; build: BuildView | null } {
  if (v === "setup" || v === "number") return { tab: "number", build: null };
  if (v === "automations") return { tab: "automations", build: null };
  if (v === "broadcasts") return { tab: "automations", build: "broadcasts" };
  // templates stays on the WhatsApp page; the drawer opens over it.
  return { tab: "home", build: null };
}

const BUILD_TITLES: Record<BuildView, string> = {
  broadcasts: "Broadcasts",
};

export function WhatsAppScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const viewParam = (search.get("view") ?? "").trim();
  const { tab, build } = fromView(viewParam);
  const canHost = account?.canHost ?? false;
  const tagsOn = (account?.features ?? []).includes(FeatureWhatsAppCRM);

  const go = useCallback(
    (t: Tab, b: BuildView | null = null) => {
      const view =
        b ??
        (t === "number" ? "setup" : t === "automations" ? "automations" : "");
      router.replace(`/host/crm${view ? `?view=${view}` : ""}`);
    },
    [router],
  );

  /* A retired or unknown ?view= already renders as the WhatsApp page (fromView).
   * Drop the query so a refresh and the address bar stay on /host/crm. */
  useEffect(() => {
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

  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
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
  }, [status, canHost, setupTick]);

  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
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
    if (tagsOn)
      engageApi
        .crmTags()
        .then((r) => !cancelled && setTags(r.tags))
        .catch(() => !cancelled && setTags([]));
    return () => {
      cancelled = true;
    };
  }, [status, canHost, tagsOn]);

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
    <div className="grid gap-4">
      {tab === "home" ? (
        <Link href="/host" className="text-[12.5px] text-ink-2 hover:text-ink">
          ← Your webinars
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => go("home")}
          className="justify-self-start text-[12.5px] text-ink-2 hover:text-ink"
        >
          ← WhatsApp
        </button>
      )}
      {tab !== "home" && (
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            {LABELS[tab]}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {tab === "number"
              ? "Your number, and what is left to set up."
              : "Every automation, and a one-off broadcast."}
          </p>
        </div>
      )}

      {tab === "home" && (
        <WhatsAppSimple
          setup={setup}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          catalogOpen={viewParam === "templates"}
          onOpen={(v) =>
            v === "setup"
              ? go("number")
              : v === "templates"
                ? router.replace("/host/crm?view=templates")
                : go("automations", v)
          }
          onCatalogClose={() => {
            if (viewParam === "templates") router.replace("/host/crm");
          }}
          onTemplatesChanged={() => void refreshTemplates()}
        />
      )}

      {tab === "automations" &&
        (build ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-2 text-[12.5px]">
              <button
                type="button"
                className="font-medium text-brand hover:underline"
                onClick={() => go("automations")}
              >
                Automations
              </button>
              <span className="text-ink-3">/</span>
              <span className="font-medium text-ink">
                {BUILD_TITLES[build]}
              </span>
            </div>
            <Broadcasts
              whatsappConnected={connected}
              templates={templates}
              templatesError={templatesError}
              syncing={syncing}
              tags={tagsOn ? (tags ?? []) : null}
              onRefreshTemplates={refreshTemplates}
            />
          </div>
        ) : (
          <Automations
            setup={setup}
            onOpenTemplates={() => router.replace("/host/crm?view=templates")}
            onBuild={(b) => go("automations", b)}
          />
        ))}

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
    </div>
  );
}

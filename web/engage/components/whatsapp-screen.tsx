"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { engageApi } from "../api";
import { Alert, Spinner, Tabs } from "@/components/controls";
import { useSession, useToast } from "@/components/providers";
import { Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  FeatureCRMTags,
  type CRMSetup,
  type CRMTag,
  type CRMTemplate,
} from "@/lib/api-types";
import { Automations, type BuildView } from "./automations";
import { Bots } from "./crm-bots";
import { Broadcasts } from "./crm-broadcasts";
import { Drips } from "./crm-drips";
import { RemindersSettings } from "./crm-screen";
import { SetupChecklist, setupTodo } from "./crm-setup";
import { StarterTemplates } from "./starter-templates";
import { BlockedList, RefreshTemplates, templateKey } from "./crm-templates";
import { CategoryPill, friendlyTemplateName } from "./wa-kit";

/* The WhatsApp page: /host/crm.
 *
 * Three tabs — Automations (recipes, and the builders under "Build your own"), Templates
 * (the approved messages and which one each automatic message uses), Number & billing
 * (the setup checklist). People and conversations are Hosting tabs; this page is for
 * what happens on its own. Old ?view= links still land: setup opens Number & billing,
 * sequences / bots / broadcasts open their builder. */

const TABS = ["automations", "templates", "number"] as const;
type Tab = (typeof TABS)[number];
const LABELS: Record<Tab, string> = {
  automations: "Automations",
  templates: "Templates",
  number: "Number & billing",
};

function fromView(v: string): { tab: Tab; build: BuildView | null } {
  if (v === "setup" || v === "number") return { tab: "number", build: null };
  if (v === "templates") return { tab: "templates", build: null };
  if (v === "sequences" || v === "bots" || v === "broadcasts")
    return { tab: "automations", build: v };
  return { tab: "automations", build: null };
}

const BUILD_TITLES: Record<BuildView, string> = {
  sequences: "Sequences",
  bots: "Bots",
  broadcasts: "Broadcasts",
};

export function WhatsAppScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const initial = fromView((search.get("view") ?? "").trim());
  const [tab, setTabState] = useState<Tab>(initial.tab);
  const [build, setBuild] = useState<BuildView | null>(initial.build);
  const canHost = account?.canHost ?? false;
  const tagsOn = (account?.features ?? []).includes(FeatureCRMTags);

  const go = useCallback(
    (t: Tab, b: BuildView | null = null) => {
      setTabState(t);
      setBuild(b);
      const view =
        b ?? (t === "number" ? "setup" : t === "templates" ? "templates" : "");
      router.replace(`/host/crm${view ? `?view=${view}` : ""}`);
    },
    [router],
  );

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
  const sendable = (templates ?? []).filter((t) => t.sendable);

  return (
    <div className="grid gap-4">
      <Link href="/host" className="text-[12.5px] text-ink-2 hover:text-ink">
        ← Hosting
      </Link>
      <div>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          WhatsApp
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-2">
          Your number, your templates, and what happens on its own.
        </p>
      </div>

      <Tabs<Tab>
        tabs={TABS}
        value={tab}
        onChange={(t) => go(t)}
        labels={LABELS}
        counts={{ templates: sendable.length, number: setupTodo(setup) }}
      />

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
            {build === "sequences" ? (
              <Drips
                whatsappConnected={connected}
                templates={templates}
                templatesError={templatesError}
                syncing={syncing}
                onRefreshTemplates={refreshTemplates}
              />
            ) : build === "bots" ? (
              <Bots whatsappConnected={connected} />
            ) : (
              <Broadcasts
                whatsappConnected={connected}
                templates={templates}
                templatesError={templatesError}
                syncing={syncing}
                tags={tagsOn ? (tags ?? []) : null}
                onRefreshTemplates={refreshTemplates}
              />
            )}
          </div>
        ) : (
          <Automations
            setup={setup}
            onOpenTemplates={() => go("templates")}
            onBuild={(b) => go("automations", b)}
          />
        ))}

      {tab === "templates" && (
        <div className="grid gap-4">
          <StarterTemplates
            connected={connected}
            onCreated={() => void refreshTemplates()}
          />
          <Card className="px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-semibold">
                  Approved templates
                </h2>
                <p className="mt-0.5 text-[12.5px] text-ink-2">
                  WhatsApp only lets you message people who haven&apos;t written
                  to you with a template Meta has approved. Create them in
                  WhatsApp Manager, then check again here.
                </p>
              </div>
              <RefreshTemplates syncing={syncing} onClick={refreshTemplates} />
            </div>
            {templatesError && (
              <div className="mt-3">
                <Alert tone="error">{templatesError}</Alert>
              </div>
            )}
            {templates === null ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {sendable.map((t) => (
                  <li
                    key={templateKey(t)}
                    className="rounded-lg border border-line px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      {friendlyTemplateName(t.name)}
                      <CategoryPill category={t.category} />
                      <span className="text-[11px] font-normal text-ink-3">
                        {t.language}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-2">
                      {t.body}
                    </p>
                  </li>
                ))}
                {sendable.length === 0 && (
                  <li className="text-[12.5px] text-ink-3">
                    No approved templates yet.
                  </li>
                )}
              </ul>
            )}
            {(templates ?? []).some((t) => !t.sendable) && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-1 text-[12px] font-medium text-ink-2">
                  Can&apos;t be used yet
                </p>
                <BlockedList
                  templates={(templates ?? []).filter((t) => !t.sendable)}
                />
              </div>
            )}
          </Card>
          <Card className="px-5 py-4">
            <h2 className="text-[15px] font-semibold">Automatic messages</h2>
            <p className="mt-0.5 mb-3 text-[12.5px] text-ink-2">
              Which template the confirmation, each reminder and the replay link
              use. The times are set per webinar.
            </p>
            <RemindersSettings
              templates={templates}
              templatesError={templatesError}
              syncing={syncing}
              onRefreshTemplates={refreshTemplates}
              onSaved={reloadSetup}
            />
          </Card>
        </div>
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
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useAppConfig, useToast } from "@/components/providers";
import { Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  TierNoShow,
  type CRMBroadcast,
  type CRMFollowupGroup,
  type CRMFollowupsResponse,
  type CRMRecipe,
  type EngagementTier,
  type EngagementTierCounts,
} from "@/lib/api-types";
import { useNow } from "@/lib/clock";
import { TIER_META, type Tier } from "@/lib/engagement/score";
import { formatRelative } from "@/lib/format";
import { followupGroups } from "../buckets";
import { NextStepCard, type NextStep } from "./messages-parts";
import { automateFor } from "./automations";
import { SendDialog, type Automate, type SendTarget } from "./send-dialog";
import { AvatarStack, Switch, pct } from "./wa-kit";

/* The Engagement tab's Follow up: one card per engagement group — the same groups the
 * page scores people into — each with the suggested message and "Review & send", or what
 * was already sent to it. The one place a coach decides who to message after a webinar;
 * the webinar's Messages tab shows what went out.
 *
 * A slot: the dashboard passes the tier counts it already has and a fallback (its
 * read-only levels), and this decides whether WhatsApp is on offer at all. */

type Meta = {
  label: string;
  dot: string;
  suggestion: string;
  /** Words a template for this group tends to use, to put the best one first. */
  hints: string[];
};

const SUGGEST: Record<string, string> = {
  high: "Send the offer while interest is hot.",
  engaged: "Thank them and share the replay and your offer.",
  passive: "Share the replay with the moment worth rewatching.",
  risk: "They left early — send the replay from where they dropped.",
  [TierNoShow]: "“We missed you” with the replay link.",
};

const HINTS = Object.fromEntries(followupGroups().map((g) => [g.id, g.hints]));

function metaFor(id: EngagementTier): Meta {
  const base = { suggestion: SUGGEST[id] ?? "", hints: HINTS[id] ?? [] };
  if (id === TierNoShow) return { label: "No-shows", dot: "bg-ink-3", ...base };
  const t = id as Tier;
  return { label: TIER_META[t].label, dot: TIER_META[t].dot, ...base };
}

function sizeOf(id: EngagementTier, tiers: EngagementTierCounts): number {
  return id === TierNoShow ? tiers.noShow : (tiers[id as Tier] ?? 0);
}

/** Who to nudge about first: the hottest group, then the people who missed it. */
const NUDGE_ORDER: EngagementTier[] = [
  "high",
  TierNoShow,
  "engaged",
  "risk",
  "passive",
];

export function EngagementFollowUp({
  slug,
  tiers,
  fallback,
}: {
  slug: string;
  tiers: EngagementTierCounts;
  /** What to show when this deployment cannot send WhatsApp at all. */
  fallback?: ReactNode;
}) {
  const config = useAppConfig();
  if (!config.whatsappConnect) return <>{fallback}</>;
  return <FollowUp slug={slug} tiers={tiers} />;
}

function FollowUp({
  slug,
  tiers,
}: {
  slug: string;
  tiers: EngagementTierCounts;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<CRMFollowupsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<SendTarget | null>(null);
  const [automate, setAutomate] = useState<Automate | undefined>(undefined);
  const [recipes, setRecipes] = useState<CRMRecipe[]>([]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // The "after every webinar" recipe behind each card.
  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmRecipes()
      .then(
        (r) =>
          !cancelled &&
          setRecipes(r.recipes.filter((x) => x.kind === "followup")),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);

  async function setAuto(g: CRMFollowupGroup, r: CRMRecipe, on: boolean) {
    try {
      if (on && !(r.configured && r.template)) {
        // The first time: pick the message in the send dialog, saved as the recipe.
        const a = automateFor(r, slug);
        setAutomate(a.automate);
        setTarget({
          ...(a.target as Extract<SendTarget, { kind: "segment" }>),
          label: metaFor(g.id).label,
        });
        return;
      }
      const res = await engageApi.saveCrmRecipe(r.id, {
        active: on,
        template: on ? r.template : undefined,
        language: on ? r.language : undefined,
        params: on ? r.params : undefined,
        delayMin: on ? r.delayMin : undefined,
      });
      setRecipes(res.recipes.filter((x) => x.kind === "followup"));
      notify(
        on
          ? `${metaFor(g.id).label} get this after every webinar.`
          : `No longer automatic for ${metaFor(g.id).label}.`,
        "ok",
      );
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that.",
        "error",
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmFollowups(slug)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            e instanceof ApiError ? e.message : "Could not load follow-ups.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [slug, tick]);

  const open = (g: CRMFollowupGroup) => {
    const m = metaFor(g.id);
    setAutomate(undefined);
    setTarget({
      kind: "segment",
      webinarId: slug,
      segment: g.segment,
      label: m.label,
      hints: m.hints,
    });
  };

  async function cancel(b: CRMBroadcast) {
    try {
      await engageApi.cancelCrmBroadcast(b.id);
      notify("Scheduled follow-up cancelled.", "ok");
      refresh();
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not cancel it.",
        "error",
      );
    }
  }

  if (error && !data)
    return (
      <Card className="px-4 py-6 text-center text-[12.5px] text-ink-3">
        {error}
      </Card>
    );
  if (!data)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );

  const nudge = data.whatsappConnected
    ? nextFollowUp(data.groups, tiers, open)
    : null;

  return (
    <div className="grid gap-3">
      {!data.whatsappConnected && (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[12.5px] text-ink-2">
          Connect your WhatsApp Business number to message these groups.{" "}
          <Link
            href="/settings#integrations"
            className="font-medium text-brand hover:underline"
          >
            Account settings
          </Link>
        </p>
      )}
      {nudge && <NextStepCard step={nudge} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {data.groups.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            size={sizeOf(g.id, tiers)}
            connected={data.whatsappConnected}
            onSend={() => open(g)}
            onCancel={cancel}
            recipe={recipes.find((r) => r.group === g.id)}
            onAuto={(r, on) => void setAuto(g, r, on)}
          />
        ))}
      </div>
      <p className="text-[11.5px] text-ink-3">
        The big number is everyone in the group; the send shows how many can get
        WhatsApp. Replies land in{" "}
        <Link
          href="/host?tab=messages"
          className="font-medium text-brand hover:underline"
        >
          Messages
        </Link>
        .
      </p>
      <SendDialog
        open={target !== null}
        target={target}
        automate={automate}
        onClose={() => {
          setTarget(null);
          setAutomate(undefined);
        }}
        onSent={refresh}
      />
    </div>
  );
}

/* The first group with people WhatsApp can reach and nothing sent to it yet. */
export function nextFollowUp(
  groups: CRMFollowupGroup[],
  tiers: EngagementTierCounts,
  onSend: (g: CRMFollowupGroup) => void,
): NextStep | null {
  for (const id of NUDGE_ORDER) {
    const g = groups.find((x) => x.id === id);
    if (!g || g.broadcast || g.audience.recipients === 0) continue;
    const n = g.audience.recipients;
    const m = metaFor(id);
    const who = id === TierNoShow ? "who didn't join" : m.label.toLowerCase();
    const people = n === 1 ? "person" : "people";
    return {
      title:
        id === TierNoShow
          ? `${n} ${people} ${who} ${n === 1 ? "hasn't" : "haven't"} heard from you yet`
          : `${n} ${who} ${people} ${n === 1 ? "hasn't" : "haven't"} heard from you yet`,
      hint: `${m.suggestion} ${sizeOf(id, tiers) > n ? `${sizeOf(id, tiers) - n} more in this group can't get WhatsApp.` : "The message is ready to review."}`,
      action: `Message ${n}`,
      run: () => onSend(g),
    };
  }
  return null;
}

function GroupCard({
  group: g,
  size,
  connected,
  onSend,
  onCancel,
  recipe,
  onAuto,
}: {
  group: CRMFollowupGroup;
  size: number;
  connected: boolean;
  onSend: () => void;
  onCancel: (b: CRMBroadcast) => void;
  /** The "after every webinar" recipe for this group, once loaded. */
  recipe?: CRMRecipe;
  onAuto: (r: CRMRecipe, on: boolean) => void;
}) {
  const m = metaFor(g.id);
  const now = useNow();
  const reach = g.audience.recipients;
  const b = g.broadcast;
  const scheduled = b && b.status === "scheduled";
  const empty = size === 0 && reach === 0;
  const people = g.faces.map((f) => ({ name: f.name, seed: f.contactId }));

  return (
    <Card
      className={`flex flex-col gap-3 px-4 py-3.5 ${empty ? "bg-surface-2/40 shadow-none" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap text-ink-2">
          <span
            className={`size-2 shrink-0 rounded-full ${m.dot}`}
            aria-hidden
          />
          <span className="truncate">{m.label}</span>
        </span>
        {b ? (
          scheduled ? (
            <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[10.5px] font-semibold text-warn">
              {now === null
                ? "Scheduled"
                : formatRelative(b.scheduledAt, new Date(now))}
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-semibold text-ok">
              Sent
            </span>
          )
        ) : reach > 0 && connected ? (
          <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] font-semibold text-brand">
            Suggested
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[26px] leading-none font-semibold tabular-nums ${empty ? "text-ink-3" : "text-ink"}`}
        >
          {size}
        </span>
        <AvatarStack people={people} />
      </div>

      {empty ? (
        <p className="text-[12px] leading-relaxed text-ink-3">
          {m.suggestion}
          <span className="mt-1 block">
            {g.id === TierNoShow
              ? "Everyone joined 🎉"
              : "Nobody in this group"}
          </span>
        </p>
      ) : b ? (
        <>
          <p
            className={`rounded-lg px-3 py-2 text-[12px] leading-relaxed ${scheduled ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}
          >
            {b.name || b.template}
            {scheduled ? (
              <> · {b.stats.recipients} queued</>
            ) : (
              <>
                {" "}
                · <b>{b.stats.read} read</b>
                {b.stats.replied > 0 && (
                  <>
                    {" "}
                    · <b>{b.stats.replied} replied</b>
                  </>
                )}
              </>
            )}
          </p>
          {scheduled ? (
            <button
              type="button"
              onClick={() => onCancel(b)}
              className="mt-auto h-9 rounded-lg border border-line-2 bg-surface text-[12.5px] font-medium text-ink hover:bg-surface-2"
            >
              Cancel
            </button>
          ) : (
            <div className="mt-auto flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{
                    width: b.stats.recipients
                      ? `${(b.stats.read / b.stats.recipients) * 100}%`
                      : 0,
                  }}
                />
              </div>
              <span
                className="text-[11px] text-ink-3 tabular-nums"
                title={`${pct(b.stats.read, b.stats.recipients)} read`}
              >
                {b.stats.read}/{b.stats.recipients}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
            {m.suggestion}
            <span className="mt-0.5 block text-[11px] text-ink-3">
              {reach} of {size} on WhatsApp
            </span>
          </p>
          <button
            type="button"
            onClick={onSend}
            disabled={!reach || !connected}
            className="mt-auto inline-flex h-9 items-center justify-center rounded-lg bg-brand text-[12.5px] font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-3"
          >
            {reach ? "Review & send" : "None on WhatsApp"}
          </button>
        </>
      )}
      {recipe && connected && (
        <div className="-mx-4 -mb-3.5 flex items-center justify-between gap-2 border-t border-line px-4 py-2">
          <span className="text-[11.5px] text-ink-2">After every webinar</span>
          <Switch
            checked={recipe.active}
            onChange={(on) => onAuto(recipe, on)}
            label={`Message ${m.label} automatically after every webinar`}
          />
        </div>
      )}
    </Card>
  );
}

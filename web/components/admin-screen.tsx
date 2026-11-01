"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { tierFeaturesToSave } from "@/lib/admin-account-features";
import {
  FeatureAI,
  PlanBasic,
  PlanBusiness,
  PlanEnterprise,
  PlanProfessional,
  type Plan,
  type PlanFeatures,
  type Webinar,
} from "@/lib/api-types";

/* The tier matrix's columns, in order; "" is no plan. Every tier the server has (store.PlanTiers):
 * saving the matrix replaces it whole, so a tier left out here would be emptied. (Starter was
 * retired into Professional on 2 Nov 2026, migrations/0185.) */
const TIER_COLUMNS: { plan: Plan | ""; label: string }[] = [
  { plan: "", label: "No plan" },
  { plan: PlanBasic, label: "Basic" },
  { plan: PlanProfessional, label: "Professional" },
  { plan: PlanBusiness, label: "Business" },
  { plan: PlanEnterprise, label: "Enterprise" },
];

import { formatDay, formatTimeRange, tzLabel } from "@/lib/format";
import { paginate } from "@/lib/paginate";
import {
  adminActionCopy,
  adminSessionActions,
  deleteConfirmMatches,
  KIND_FILTERS,
  sessionNoun,
  type AdminSessionAction,
  type AdminSessionKindFilter,
} from "@/lib/admin-session-actions";
import { useAppConfig, useToast } from "./providers";
import {
  Alert,
  ConfirmModal,
  Modal,
  Spinner,
  Tabs,
} from "./controls";
import { DateRangeField } from "./date-picker";
import { AdminRecordingPurge } from "./admin-recording-purge";
import { AdminSiteBanner } from "./admin-site-banner";
import { AdminSiteSettings } from "./admin-site-settings";
import { Badge, ButtonLink, Card, Empty, SectionTitle } from "./ui";
import { AdminDashboard, type WebinarStatusFilter } from "./admin-dashboard";
import { AdminSales } from "./admin-sales";
import { AdminCostCalculator } from "./admin-cost-calculator";
import { AdminHostCosts } from "./admin-host-costs";
import { AdminAccounts } from "./admin-accounts";
import { ArrowLeftIcon, SparklesIcon } from "./icons";

/* The admin panel: a dashboard first, then the two lists.
 *
 * Dashboard is the landing view because an operator opening this page is
 * asking "is anything on air, and is the instance healthy" before they are
 * asking to edit a row. Accounts and Webinars are the same screens this page
 * used to show stacked — hosting, the per-account switches, deletion, and
 * the webinar filters — reached from the tabs rather than scrolled to.
 *
 * There is still no control here for making somebody an admin, and that is
 * the design rather than a missing feature. A privilege that can be granted
 * through the UI can be granted by whoever takes over one admin account, and
 * then the boundary has bought nothing. Admins come from ADMIN_EMAILS on the
 * server, which needs access to the machine to change.
 */

const ADMIN_TABS = ["dashboard", "accounts", "plans", "webinars", "sales", "costs", "hostCosts"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];


const PAGE_SIZE = 10;

export function AdminScreen({
  initialTab = "dashboard",
  salesConversation = null,
}: {
  initialTab?: AdminTab;
  /** Opens this sales chat: the link in the handoff email is /admin/sales?c=<id>. */
  salesConversation?: string | null;
} = {}) {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const [salesWaiting, setSalesWaiting] = useState(0);
  /* n remounts the webinar list. A drill-down from the dashboard ("upcoming")
   * and a click on the Webinars tab are not the same arrival: the first
   * should open already filtered, the second should open on every webinar,
   * and neither should inherit whatever filter was left selected last time. */
  const [webinarView, setWebinarView] = useState<{
    status: WebinarStatusFilter;
    n: number;
  }>({ status: "", n: 0 });

  function openWebinars(status: WebinarStatusFilter) {
    setWebinarView((v) => ({ status, n: v.n + 1 }));
    setTab("webinars");
  }

  return (
    <div>
      <Tabs
        tabs={ADMIN_TABS}
        value={tab}
        onChange={(next) => {
          if (next === tab) return;
          if (next === "webinars") {
            setWebinarView((v) => ({ status: "", n: v.n + 1 }));
          }
          setTab(next);
        }}
        labels={{
          dashboard: "Dashboard",
          accounts: "Accounts",
          plans: "Plans",
          webinars: "Webinars",
          sales: "Sales chats",
          costs: "Cost calculator",
          hostCosts: "Cost by host",
        }}
        counts={salesWaiting ? { sales: salesWaiting } : undefined}
      />
      <div className="mt-5">
        {tab === "dashboard" && (
          <>
            <AdminSiteBanner />
            <AdminSiteSettings />
            <AdminDashboard onAccounts={() => setTab("accounts")} onWebinars={openWebinars} />
            <AdminRecordingPurge />
          </>
        )}
        {tab === "accounts" && <AdminAccounts />}
        {tab === "plans" && <PlanMatrix />}
        {tab === "webinars" && (
          <AdminWebinars key={webinarView.n} initialStatus={webinarView.status} />
        )}
        {tab === "sales" && <AdminSales initialId={salesConversation} onCount={setSalesWaiting} />}
        {tab === "costs" && <AdminCostCalculator />}
        {tab === "hostCosts" && <AdminHostCosts />}
      </div>
    </div>
  );
}

/* Which features each plan includes, for every account on it without an override.
 *
 * Edited as a grid and saved whole: the server replaces the matrix in one
 * transaction, so nobody reads half of a save. Attendee caps are not here — they
 * are part of the plan's price (types.PlanAttendeeCap). */
function PlanMatrix() {
  const { featureCatalogue } = useAppConfig();
  const { notify } = useToast();
  const [saved, setSaved] = useState<PlanFeatures[] | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const adopt = useCallback((tiers: PlanFeatures[]) => {
    setSaved(tiers);
    setDraft(Object.fromEntries(tiers.map((t) => [t.plan, new Set(t.features)])));
  }, []);

  useEffect(() => {
    api
      .planFeatures()
      .then((body) => {
        adopt(body.tiers);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load plans."));
  }, [adopt]);

  const dirty =
    saved !== null &&
    saved.some((t) => {
      const d = draft[t.plan] ?? new Set<string>();
      return d.size !== t.features.length || t.features.some((f) => !d.has(f));
    });

  function toggle(plan: string, key: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev[plan] ?? []);
      if (on) next.add(key);
      else next.delete(key);
      return { ...prev, [plan]: next };
    });
  }

  async function save() {
    setSaving(true);
    try {
      const body = await api.setPlanFeatures(
        TIER_COLUMNS.map((c) => ({
          plan: c.plan,
          features: tierFeaturesToSave(draft[c.plan] ?? [], featureCatalogue),
        })),
      );
      adopt(body.tiers);
      notify("Plans saved. Accounts without an override follow them now.", "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not save plans.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div>
        <SectionTitle>Plans</SectionTitle>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          What each plan includes. An account follows its plan unless it has its own
          override under Accounts → Features. AI features are off on every plan: turn them on
          for a host under Accounts → Features.
        </p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Card className="overflow-x-auto p-0">
        {saved === null ? (
          <div className="grid place-items-center p-8">
            <Spinner className="size-5" />
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-ink-2">
                <th className="px-4 py-2.5 font-medium">Feature</th>
                {TIER_COLUMNS.map((c) => (
                  <th key={c.plan || "none"} className="px-3 py-2.5 text-center font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {featureCatalogue.map((f) => (
                <tr key={f.key} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink-1">
                      {f.key === FeatureAI && <SparklesIcon className="mr-1 inline size-3.5 align-[-2px] text-brand" />}
                      {f.label}
                    </div>
                    <div className="text-[12px] text-ink-3">{f.description}</div>
                  </td>
                  {TIER_COLUMNS.map((c) => (
                    <td key={c.plan || "none"} className="px-3 py-2.5 text-center">
                      {f.perHost ? (
                        <span
                          className="text-[12px] text-ink-3"
                          title="Off on every plan. Turn it on for a host under Accounts → Features."
                        >
                          Per host
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`${f.label} in ${c.label}`}
                          checked={draft[c.plan]?.has(f.key) ?? false}
                          onChange={(e) => toggle(c.plan, f.key, e.target.checked)}
                          className="size-4 cursor-pointer accent-brand"
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => saved && adopt(saved)}
          className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          Reset
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="rounded-lg bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save plans"}
        </button>
      </div>
    </div>
  );
}

/* Every session on the instance — webinars, meetings and simulives, completed
 * and upcoming, filterable by kind, status and date, searchable by topic or the
 * host's email — with what an admin can do that a host can't: end, publish or
 * unpublish, and delete a session that isn't theirs. Which buttons a row offers,
 * and what each confirm says, is lib/admin-session-actions.ts; the server
 * (admin_sessions.go) is what actually enforces it.
 *
 * A separate component, and a separate fetch, from the accounts list above:
 * the two lists have nothing in common and a host running a hundred webinars
 * must not make the accounts table (used every time an admin checks a single
 * person) wait on it.
 */
const STATUSES = [
  { value: "", label: "All" },
  { value: "live", label: "Live" },
  { value: "scheduled", label: "Scheduled" },
  { value: "draft", label: "Draft" },
  { value: "ended", label: "Ended" },
] as const;

function statusTone(status: string): "neutral" | "brand" | "ok" | "live" {
  switch (status) {
    case "live":
      return "live";
    case "scheduled":
      return "brand";
    case "ended":
      return "ok";
    default:
      return "neutral";
  }
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        active ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

const ACTION_LABEL: Record<AdminSessionAction, string> = {
  end: "End now",
  publish: "Publish",
  unpublish: "Move to draft",
  delete: "Delete",
};

function AdminWebinars({
  initialStatus = "",
}: {
  /* From a dashboard drill-down. The list remounts when this changes — see
   * webinarView in AdminScreen — so the chips open on the status that was
   * asked for rather than remembering a previous visit. */
  initialStatus?: WebinarStatusFilter;
}) {
  const { notify } = useToast();
  const [rows, setRows] = useState<Webinar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WebinarStatusFilter>(initialStatus);
  const [kind, setKind] = useState<AdminSessionKindFilter>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  /* The action waiting on its confirm, and the row it is for. One at a time:
   * every action has a dialog, so two can never be in flight from this list. */
  const [pending, setPending] = useState<{ action: AdminSessionAction; slug: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // What the admin typed into the delete confirm. Cleared with each new dialog.
  const [typed, setTyped] = useState("");
  /* Reset with the filter. Each chip, date range and search is its own list:
   * staying on page 3 of All and then opening Live should not come back to
   * page 3. A delete that only shortens the current list is left to
   * paginate(), which clamps. */
  const [pageIndex, setPageIndex] = useState(0);

  const load = useCallback(() => {
    api
      .adminWebinars({
        status: status || undefined,
        kind: kind || undefined,
        from: from || undefined,
        to: to || undefined,
        q: query || undefined,
      })
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load sessions.");
      });
  }, [status, kind, from, to, query]);

  useEffect(load, [load]);

  const view = useMemo(
    () => paginate(rows ?? [], PAGE_SIZE, pageIndex),
    [rows, pageIndex],
  );

  function ask(action: AdminSessionAction, slug: string) {
    setTyped("");
    setPending({ action, slug });
  }

  async function run(action: AdminSessionAction, slug: string) {
    setBusy(true);
    try {
      if (action === "delete") {
        await api.adminDeleteWebinar(slug);
        setRows((prev) => (prev ?? []).filter((w) => w.id !== slug));
        notify("Deleted.", "ok");
      } else {
        const updated =
          action === "end"
            ? await api.adminEndWebinar(slug)
            : await api.adminSetWebinarStatus(
                slug,
                action === "publish" ? "scheduled" : "draft",
              );
        /* Replaced in place rather than refetched, so the row stays where the
         * admin was looking even when it no longer matches the status chip;
         * the next filter change drops it. */
        setRows((prev) => (prev ?? []).map((w) => (w.id === slug ? updated : w)));
        notify(
          action === "end"
            ? "Ended."
            : action === "publish"
              ? "Published."
              : "Moved to draft.",
          "ok",
        );
      }
      setPending(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  }

  const target = rows?.find((w) => w.id === pending?.slug) ?? null;
  const copy = pending && target ? adminActionCopy(pending.action, target) : null;
  const deleteArmed = target ? deleteConfirmMatches(typed, target.topic) : false;

  return (
    <div>
      <div className="mb-3">
        <SectionTitle>Webinars and meetings</SectionTitle>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          Every session on this instance, across every host. End one that is
          live, publish or unpublish one that hasn&apos;t started, or delete it.
        </p>
      </div>

      <Card className="p-4">
        <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          {KIND_FILTERS.map((k) => (
            <FilterChip
              key={k.value}
              active={kind === k.value}
              onClick={() => {
                if (k.value !== kind) setPageIndex(0);
                setKind(k.value);
              }}
            >
              {k.label}
            </FilterChip>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-1 flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {STATUSES.map((s) => (
              <FilterChip
                key={s.value}
                active={status === s.value}
                onClick={() => {
                  if (s.value !== status) setPageIndex(0);
                  setStatus(s.value);
                }}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
          <DateRangeField
            from={from}
            to={to}
            ariaLabel="Filter sessions by date"
            onChange={(nextFrom, nextTo) => {
              setFrom(nextFrom);
              setTo(nextTo);
              setPageIndex(0);
            }}
          />
        </div>

        <input
          className="field mb-3 w-full max-w-sm"
          placeholder="Search by topic or host email…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPageIndex(0);
          }}
          aria-label="Search sessions"
        />

        {error && <Alert tone="error">{error}</Alert>}

        {rows === null ? (
          <div className="grid gap-2">
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title="Nothing matches"
            hint="Try a wider date range, a different kind or status."
          />
        ) : (
          <div className="grid gap-2">
            {view.items.map((w) => (
              <div
                key={w.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">
                      {w.topic}
                    </span>
                    <Badge tone={statusTone(w.status)} dot={w.status === "live"}>
                      {w.status}
                    </Badge>
                    {(w.kind === "meeting" || w.kind === "simulive") && (
                      <Badge tone="neutral">{sessionNoun(w.kind)}</Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-ink-3">
                    {formatDay(w.startsAt, w.timeZone)} ·{" "}
                    {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
                    {tzLabel(w.startsAt, w.timeZone)} · hosted by{" "}
                    {w.host.name || "—"}
                    {w.registrantCount > 0 &&
                      ` · ${w.registrantCount} registrant${w.registrantCount === 1 ? "" : "s"}`}
                  </div>
                </div>

                {busy && pending?.slug === w.id ? (
                  <Spinner className="size-4" />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* The host page is read-only for an admin: its own buttons
                        still gate on being the host or a co-host (requireOwnership
                        in api/internal/api/auth.go). What an admin can change is
                        here, beside it. */}
                    <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                      View
                    </ButtonLink>
                    {w.kind !== "meeting" && w.status !== "ended" && (
                      <AudienceCapSelect
                        webinar={w}
                        onSaved={(updated) =>
                          setRows((prev) => (prev ?? []).map((r) => (r.id === updated.id ? updated : r)))
                        }
                      />
                    )}
                    {adminSessionActions(w).map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => ask(action, w.id)}
                        className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 ${
                          action === "end" || action === "delete"
                            ? "text-live hover:bg-live-soft focus-visible:ring-live/40"
                            : "text-ink-2 hover:bg-surface-2 focus-visible:ring-brand/40"
                        }`}
                      >
                        {ACTION_LABEL[action]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <ListPager page={view.page} pages={view.pages} onPage={setPageIndex} />
          </div>
        )}
      </Card>

      {/* End and the status moves: a plain confirm that says what happens. */}
      <ConfirmModal
        open={pending !== null && pending.action !== "delete" && copy !== null}
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => pending && void run(pending.action, pending.slug)}
        title={copy?.title ?? ""}
        body={copy?.body ?? ""}
        confirmLabel={copy?.confirm ?? "Confirm"}
      />

      {/* Delete has no way back, so it is armed by typing the topic or DELETE. */}
      <Modal
        open={pending?.action === "delete" && copy !== null}
        onClose={() => setPending(null)}
        title={copy?.title ?? ""}
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={busy}
              className="h-9 rounded-lg border border-line-2 px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => pending && void run("delete", pending.slug)}
              disabled={busy || !deleteArmed}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-live px-3.5 text-[13px] font-medium text-on-live hover:bg-live/90 disabled:opacity-50"
            >
              {busy && <Spinner className="size-3.5" />}
              {copy?.confirm ?? "Delete"}
            </button>
          </>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-ink-2">{copy?.body}</p>
        <label className="mt-3 block text-[12.5px] font-medium text-ink-2">
          Type the topic or DELETE to confirm
          <input
            className="field mt-1.5 w-full"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && deleteArmed && pending && !busy) {
                void run("delete", pending.slug);
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </Modal>
    </div>
  );
}

/* Same control as the stage grid's pager: arrow buttons, the page in the
 * middle, and nothing at all when the list fits on one page. Colours follow
 * this screen (surface / ink / brand) rather than the room's white-on-dark. */
function ListPager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-2 flex items-center justify-center gap-2">
      <PageButton
        label="Previous page"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <ArrowLeftIcon className="size-3.5" />
      </PageButton>
      <span className="text-[11.5px] font-medium tabular-nums text-ink-2">
        {page + 1} / {pages}
      </span>
      <PageButton
        label="Next page"
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
      >
        <ArrowLeftIcon className="size-3.5 rotate-180" />
      </PageButton>
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg bg-surface-2 text-ink-2 transition-colors hover:bg-line hover:text-ink disabled:opacity-35 disabled:hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      {children}
    </button>
  );
}

/* The audience ceiling for one webinar (AudienceCapOverride). "Usual" is the plan's cap and
 * the 300 every webinar is held to; a number replaces both and becomes the attendee limit. The
 * video box placement counts a webinar by this number, so raising one past 300 reserves box
 * capacity for it. */
const AUDIENCE_CAP_CHOICES = [100, 200, 300, 400, 500, 750, 1000] as const;

function AudienceCapSelect({
  webinar,
  onSaved,
}: {
  webinar: Webinar;
  onSaved: (w: Webinar) => void;
}) {
  const { notify } = useToast();
  const [saving, setSaving] = useState(false);
  const current = webinar.audienceCapOverride ?? 0;
  const choices: number[] = [...AUDIENCE_CAP_CHOICES];
  if (current > 0 && !choices.includes(current)) choices.push(current);
  choices.sort((a, b) => a - b);
  return (
    <select
      aria-label={`Audience ceiling for ${webinar.topic}`}
      title={`${webinar.attendeeLimit} seats now. An admin ceiling replaces the plan's cap.`}
      value={current > 0 ? String(current) : ""}
      disabled={saving}
      onChange={(e) => {
        const next = e.target.value === "" ? null : Number(e.target.value);
        setSaving(true);
        api
          .adminSetAudienceCap(webinar.id, next)
          .then((updated) => {
            onSaved(updated);
            notify(
              next === null
                ? `Back to the usual ceiling: ${updated.attendeeLimit} seats.`
                : `${updated.attendeeLimit} seats for this webinar.`,
              "ok",
            );
          })
          .catch((err: unknown) => notify(err instanceof Error ? err.message : "That didn't work.", "error"))
          .finally(() => setSaving(false));
      }}
      className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
    >
      <option value="">Seats: usual ({webinar.attendeeLimit})</option>
      {choices.map((n) => (
        <option key={n} value={n}>
          Seats: {n.toLocaleString()}
        </option>
      ))}
    </select>
  );
}

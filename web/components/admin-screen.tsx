"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  accountFeatureRows,
  accountFeaturesOnCount,
  bulkGrants,
  groupFeatureRows,
  unmetRequirements,
  withOverrides,
  type AccountFeatureGroup,
  overrideState,
  planIncludes,
  withOverride,
  type AccountFeatureRow,
  type OverrideState,
} from "@/lib/admin-account-features";
import { COSTS, FEATURE_COSTS, stageCostText } from "@/lib/admin-costs";
import {
  DefaultMediaQuotaMB,
  FeatureAI,
  FeatureInstantWebinar,
  MaxMediaQuotaMB,
  PlanBusiness,
  PlanEnterprise,
  PlanLaunchAttendees,
  PlanProfessional,
  type AccountKind,
  type AdminAccountCounts,
  type AdminUser,
  type Plan,
  type PlanFeatures,
  type SFUProjectOption,
  type Webinar,
} from "@/lib/api-types";

// The tier matrix's columns, in order; "" is no plan.
const TIER_COLUMNS: { plan: Plan | ""; label: string }[] = [
  { plan: "", label: "No plan" },
  { plan: PlanProfessional, label: "Professional" },
  { plan: PlanBusiness, label: "Business" },
  { plan: PlanEnterprise, label: "Enterprise" },
];

// What the plan select offers, with each plan's attendee cap (types.PlanAttendeeCap).
const PLAN_LABEL: Record<Plan, string> = {
  [PlanProfessional]: "Professional · 200",
  [PlanBusiness]: "Business · 300",
  [PlanEnterprise]: "Enterprise · 500",
};
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
import {
  ACCOUNT_ROLE_FILTERS,
  ACCOUNT_ROLE_LABEL,
  countAccountRoles,
  filterAccounts,
  type AccountRoleFilter,
} from "@/lib/admin-accounts-filter";
import { useAppConfig, useSession, useToast } from "./providers";
import {
  Alert,
  ConfirmModal,
  Disclosure,
  Modal,
  Spinner,
  Tabs,
  Toggle,
} from "./controls";
import { DateRangeField } from "./date-picker";
import { Avatar, Badge, ButtonLink, Card, Empty, SectionTitle } from "./ui";
import { AdminDashboard, type WebinarStatusFilter } from "./admin-dashboard";
import { AdminSales } from "./admin-sales";
import { AdminCostCalculator } from "./admin-cost-calculator";
import { AdminHostCosts } from "./admin-host-costs";
import { RecordingStorageField } from "./admin-recording-storage";
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
          <AdminDashboard onAccounts={() => setTab("accounts")} onWebinars={openWebinars} />
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

function AdminAccounts() {
  const { account } = useSession();
  const { notify } = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<AccountRoleFilter>("all");
  /* Rows whose hosting was flipped since the chip or search last changed. Kept
   * in view so a toggle under "Hosts" or "Attendees" does not yank the row away
   * mid-click; cleared whenever the admin changes what they are looking at. */
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  /* Two lists: people who signed up for Webinar Liv, and people a coach's webinar
   * brought in (an account is made when somebody registers). */
  const [kind, setKind] = useState<AccountKind>("customer");
  const [counts, setCounts] = useState<AdminAccountCounts | null>(null);
  const [confirmMove, setConfirmMove] = useState<AdminUser | null>(null);
  /* Reset with the query. The page index outlives the filtered list, and
   * paginate() would clamp onto the last page of a narrower search rather
   * than the first. A delete that only shortens the current list is left to
   * that clamp. */
  const [pageIndex, setPageIndex] = useState(0);

  /* Not async, and the state writes are inside .then().
   *
   * react-hooks/set-state-in-effect rejects an async function called from an effect body —
   * it cannot see that everything after the first await is a later tick. Same shape as
   * useDevices in lib/media.ts. */
  // The tier matrix, so each feature's Inherit can say what the plan gives.
  const [tiers, setTiers] = useState<PlanFeatures[] | null>(null);
  // Video servers; the per-host select only appears when there is more than one.
  const [sfuProjects, setSfuProjects] = useState<SFUProjectOption[]>([]);

  const load = useCallback(() => {
    api
      .adminUsers("", kind)
      .then((rows) => {
        setUsers(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load accounts.");
      });
    api
      .adminAccountCounts()
      .then(setCounts)
      .catch(() => setCounts(null));
    api
      .planFeatures()
      .then((body) => setTiers(body.tiers))
      .catch(() => setTiers(null));
    api
      .sfuProjects()
      .then((body) => setSfuProjects(body.projects))
      .catch(() => setSfuProjects([]));
  }, [kind]);

  useEffect(load, [load]);

  /* Filtered in the browser rather than re-querying per keystroke.
   *
   * The server takes a `q` and this deployment has seven accounts. Sending a request per
   * keystroke to filter a list that fits on one screen is a round trip for nothing; the
   * server-side filter is there for when this grows, and switching to it is a one-line
   * change to the load call. */
  const shown = useMemo(
    () => (users ? filterAccounts(users, query, roleFilter, pinned) : null),
    [users, query, roleFilter, pinned],
  );

  // Off the search only, not the chip, so each chip says what clicking it shows.
  const roleCounts = useMemo(
    () => countAccountRoles(users ?? [], query),
    [users, query],
  );

  const view = useMemo(
    () => paginate(shown ?? [], PAGE_SIZE, pageIndex),
    [shown, pageIndex],
  );

  async function setHost(u: AdminUser, canHost: boolean) {
    setBusy(u.id);
    try {
      await api.setHostCapability(u.id, canHost);
      if (roleFilter !== "all") setPinned((prev) => new Set(prev).add(u.id));
      // Patched in place rather than refetching the list: a full reload would reorder the
      // table under the cursor, because the ordering puts hosts first.
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, canHost } : row,
        ),
      );
      notify(
        canHost
          ? `${u.name || u.email} can now host webinars.`
          : `Hosting removed from ${u.name || u.email}.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setMaxDuration(u: AdminUser, maxDurationMin: number | null) {
    setBusy(u.id);
    try {
      await api.setUserMaxDuration(u.id, maxDurationMin);
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          // null is how the API says "back to the system default"; the type it
          // hands back omits the field instead, so the two have to agree here.
          row.id === u.id ? { ...row, maxDurationMin: maxDurationMin ?? undefined } : row,
        ),
      );
      notify(
        maxDurationMin
          ? `Max meeting duration for ${u.name || u.email} set to ${maxDurationMin} minutes.`
          : `Max meeting duration for ${u.name || u.email} reset to system default.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setMediaQuota(u: AdminUser, mb: number | null) {
    setBusy(u.id);
    try {
      const saved = await api.setUserMediaQuota(u.id, mb === null ? null : Math.round(mb * MB));
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id
            ? {
                ...row,
                mediaQuotaBytes: saved.mediaQuotaBytes,
                mediaLimitBytes: saved.mediaQuotaBytes ?? defaultMediaLimit(prev ?? []),
              }
            : row,
        ),
      );
      notify(
        mb === null
          ? `Media storage for ${u.name || u.email} is back on the default.`
          : `Media storage for ${u.name || u.email} set to ${mb} MB.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setPlan(u: AdminUser, plan: Plan | "") {
    setBusy(u.id);
    try {
      const updated = await api.setUserPlan(u.id, plan);
      // A plan change changes what the account inherits, so take the server's features.
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, plan: plan || undefined, features: updated.features } : row,
        ),
      );
      notify(
        plan
          ? `${u.name || u.email} is on the ${PLAN_LABEL[plan]} plan.`
          : `${u.name || u.email} is back on the launch default.`,
        "ok",
      );
      load(); // the plan sets the stage seats too; the server computes them
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  /* Meetings are sized separately from webinar stages: everyone in a meeting is on camera, but
   * each person pulls at most a page of thumbnails, so it grows with the room. Raising it says
   * so and asks first, because 50 is the heaviest room this server runs. */
  async function setMeetingCap(u: AdminUser, meetingCap: number | null) {
    const next = meetingCap ?? u.planMeetingSeats;
    if (next > u.planMeetingSeats &&
        !window.confirm(
          `Allow meetings of up to ${next} people for ${u.name || u.email}? Their plan allows ${u.planMeetingSeats}.\n\n` +
          "Webinar stages are not affected.",
        )) {
      return;
    }
    setBusy(u.id);
    try {
      await api.setUserMeetingCap(u.id, meetingCap);
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, meetingCap: meetingCap ?? undefined, meetingSeats: next } : row,
        ),
      );
      notify(
        meetingCap === null
          ? `${u.name || u.email} is back on the plan's meeting size (${u.planMeetingSeats} people).`
          : `${u.name || u.email} may hold meetings of ${meetingCap} people.`,
        "ok",
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change the meeting size.", "error");
    } finally {
      setBusy(null);
    }
  }

  /* A bigger stage is the costliest switch here (traffic grows with its square), so raising
   * it above the plan says what it costs and asks first. */
  async function setStageCap(u: AdminUser, stageCap: number | null) {
    const next = stageCap ?? u.planStageSeats;
    if (next > u.planStageSeats &&
        !window.confirm(
          `Allow ${next} people on stage for ${u.name || u.email}? Their plan allows ${u.planStageSeats}.\n\n` +
          stageCostText(next) + "\n\nThis applies to every webinar they run.",
        )) {
      return;
    }
    setBusy(u.id);
    try {
      await api.setUserStageCap(u.id, stageCap);
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, stageCap: stageCap ?? undefined, stageSeats: next } : row,
        ),
      );
      notify(
        stageCap === null
          ? `${u.name || u.email} is back on the plan's stage (${u.planStageSeats} people).`
          : `${u.name || u.email} may have ${stageCap} people on stage.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setVideoServer(u: AdminUser, project: string) {
    setBusy(u.id);
    try {
      await api.setUserSFU(u.id, project);
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, sfuProject: project || undefined } : row,
        ),
      );
      const label = sfuProjects.find((p) => p.id === project)?.label;
      notify(
        project
          ? `${u.name || u.email}'s new webinars will use ${label ?? project}.`
          : `${u.name || u.email}'s new webinars will use the default video server.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  // One more free trial past the once-per-person check; spent when it starts.
  async function allowTrial(u: AdminUser) {
    setBusy(u.id);
    try {
      await api.allowAnotherTrial(u.id);
      setUsers((prev) => (prev ?? []).map((row) => (row.id === u.id ? { ...row, trialExemption: true } : row)));
      notify(`${u.name || u.email} can take one more free trial.`, "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  // The payment-method match has been looked at.
  async function clearTrialFlag(u: AdminUser) {
    setBusy(u.id);
    try {
      await api.clearTrialFlags(u.id);
      setUsers((prev) => (prev ?? []).map((row) => (row.id === u.id ? { ...row, trialFlag: undefined } : row)));
      notify(`Trial review cleared for ${u.name || u.email}.`, "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  // Moves an account to the other list. Hosting is not granted or removed by this.
  async function moveAccount(u: AdminUser, to: AccountKind) {
    setBusy(u.id);
    try {
      await api.setAccountKind(u.id, to);
      setUsers((prev) => (prev ?? []).filter((row) => row.id !== u.id));
      setCounts((c) =>
        c
          ? to === "customer"
            ? { customers: c.customers + 1, audience: Math.max(0, c.audience - 1) }
            : { customers: Math.max(0, c.customers - 1), audience: c.audience + 1 }
          : c,
      );
      setConfirmMove(null);
      notify(
        to === "customer"
          ? `${u.name || u.email} moved to customers.`
          : `${u.name || u.email} moved to webinar audience.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  /* Refused server-side too — for the caller's own account, and for one that
   * still owns webinars — this only saves the round trip and gives the error
   * a place to land next to the button that caused it. */
  async function deleteAccount(u: AdminUser) {
    setDeleting(true);
    try {
      await api.adminDeleteUser(u.id);
      setUsers((prev) => (prev ?? []).filter((row) => row.id !== u.id));
      setConfirmDelete(null);
      notify(`Deleted ${u.name || u.email}.`, "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not delete that account.", "error");
    } finally {
      setDeleting(false);
    }
  }

  const hosts = users?.filter((u) => u.canHost).length ?? 0;

  return (
    <div className="grid gap-4">
      <div>
        <SectionTitle>Accounts</SectionTitle>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          Hosting is granted here and nowhere else. Signing up no longer gives
          anybody the ability to create webinars.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div role="tablist" aria-label="Account lists" className="flex flex-wrap gap-1.5">
        {(
          [
            ["customer", "Customers", counts?.customers],
            ["audience", "Webinar audience", counts?.audience],
          ] as const
        ).map(([value, label, n]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              if (kind === value) return;
              setKind(value);
              setUsers(null);
              setRoleFilter("all");
              setPinned(new Set());
              setPageIndex(0);
            }}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
              kind === value
                ? "border-brand/40 bg-brand-soft text-brand"
                : "border-line text-ink-2 hover:bg-surface-2"
            }`}
          >
            {label}
            {n !== undefined ? ` (${n})` : ""}
          </button>
        ))}
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <input
            className="field max-w-sm flex-1"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPinned(new Set());
              setPageIndex(0);
            }}
            aria-label="Search accounts"
          />
          {/* Hosts / Attendees only split the customer list: an audience account
              never hosts (granting hosting promotes it to a customer). */}
          {kind === "customer" && (
            <div
              role="group"
              aria-label="Filter accounts by role"
              className="flex flex-wrap gap-1.5"
            >
              {ACCOUNT_ROLE_FILTERS.map((r) => {
                const active = roleFilter === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      if (r === roleFilter) return;
                      setRoleFilter(r);
                      setPinned(new Set());
                      setPageIndex(0);
                    }}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      active ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2"
                    }`}
                  >
                    {ACCOUNT_ROLE_LABEL[r]}
                    <span
                      className={`rounded-full px-1.5 text-[11px] leading-4 tabular-nums ${
                        active ? "bg-brand/15 text-brand" : "bg-surface-2 text-ink-2"
                      }`}
                    >
                      {users ? roleCounts[r] : "–"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <span className="ml-auto text-[12.5px] text-ink-3">
            {kind === "customer"
              ? `${hosts} of ${users?.length ?? 0} can host`
              : "Created by registering for a webinar"}
          </span>
        </div>

        {shown === null ? (
          <div className="grid gap-2">
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
          </div>
        ) : shown.length === 0 ? (
          <Empty
            title="No accounts match"
            hint={
              roleFilter === "all"
                ? "Try a different name or email."
                : `No ${ACCOUNT_ROLE_LABEL[roleFilter].toLowerCase()} match. Try All, or a different name or email.`
            }
          />
        ) : (
          <div className="grid gap-2">
            {view.items.map((u) => {
              const isSelf = u.id === account?.id;
              return (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5"
                >
                  <Avatar
                    person={{
                      id: u.id,
                      name: u.name,
                      title: u.title ?? "",
                      org: u.org ?? "",
                      initials: u.initials,
                      hue: u.hue,
                    }}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate text-[13px] font-medium">
                        {u.name}
                      </span>
                      {u.isAdmin && <Badge tone="brand">Admin</Badge>}
                      {!u.emailVerified && <Badge tone="warn">Email unverified</Badge>}
                      {isSelf && <Badge>You</Badge>}
                    </div>
                    {/* How to reach this person, then what they've done with the
                        capability. The phone is only shown when there is one, rather
                        than as an em dash holding an empty column: it comes from the
                        signup form, so accounts that arrived through Google — and any
                        created before migrations/0020 — simply have no number, and a
                        row of dashes would read as "we lost it". */}
                    <div className="truncate text-[12px] text-ink-3">
                      {[
                        u.email,
                        u.phone,
                        u.webinarCount > 0
                          ? `${u.webinarCount} webinar${u.webinarCount === 1 ? "" : "s"}`
                          : "",
                        kind === "audience" && u.registrationCount > 0
                          ? `Registered for ${u.registrationCount} webinar${u.registrationCount === 1 ? "" : "s"}` +
                            (u.lastWebinarTopic ? ` · latest: ${u.lastWebinarTopic}` : "")
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>

                  {busy === u.id ? (
                    <Spinner className="size-4" />
                  ) : kind === "audience" ? (
                    <button
                      type="button"
                      onClick={() => void moveAccount(u, "customer")}
                      className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-1 transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      Move to customers
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      {!u.canHost && !u.plan && !u.isAdmin && (
                        <button
                          type="button"
                          onClick={() => setConfirmMove(u)}
                          className="text-[11.5px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                        >
                          Move to audience
                        </button>
                      )}
                      <Toggle
                        checked={u.canHost}
                        /* Self-revoke is refused by the server too — this only saves the
                         * round trip. It is the one lockout with no way back from inside
                         * the app: the toggle you would use to restore it is this one. */
                        disabled={isSelf && u.canHost}
                        onChange={(next) => void setHost(u, next)}
                        label="Can host"
                        description={`Cost: ${COSTS.canHost}`}
                      />

                      {/* Max meeting duration — only shown for hosts */}
                      {u.canHost && (
                        <select
                          aria-label="Max meeting duration"
                          title={`Max meeting duration. Cost: ${COSTS.maxDuration}`}
                          value={u.maxDurationMin ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            void setMaxDuration(u, val === "" ? null : Number(val));
                          }}
                          className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                        >
                          <option value="">Default (3h)</option>
                          <option value="60">1 hour</option>
                          <option value="120">2 hours</option>
                          <option value="180">3 hours</option>
                          <option value="240">4 hours</option>
                          <option value="360">6 hours</option>
                          <option value="480">8 hours</option>
                        </select>
                      )}

                      {u.canHost && (
                        <MediaQuotaField
                          key={`${u.id}:${u.mediaQuotaBytes ?? ""}`}
                          user={u}
                          defaultBytes={defaultMediaLimit(users ?? [])}
                          disabled={busy === u.id}
                          onSave={(mb) => void setMediaQuota(u, mb)}
                        />
                      )}

                      {u.canHost && (
                        <RecordingStorageField
                          key={u.id}
                          user={u}
                          onSaved={(patch) =>
                            setUsers((prev) =>
                              (prev ?? []).map((row) => (row.id === u.id ? { ...row, ...patch } : row)),
                            )
                          }
                        />
                      )}

                      {u.canHost && (
                        <select
                          aria-label="Plan"
                          title={`Plan (sets the attendee and stage caps). Cost: ${COSTS.plan}`}
                          value={u.plan ?? ""}
                          onChange={(e) => void setPlan(u, e.target.value as Plan | "")}
                          className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                        >
                          <option value="">No plan ({PlanLaunchAttendees} attendees)</option>
                          {(Object.keys(PLAN_LABEL) as Plan[]).map((p) => (
                            <option key={p} value={p}>
                              {PLAN_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      )}

                      {u.canHost && (
                        <select
                          aria-label="People on stage"
                          title={`People on stage at once, host included. Cost: ${stageCostText(u.stageSeats)}`}
                          value={u.stageCap ?? ""}
                          disabled={busy === u.id}
                          onChange={(e) =>
                            void setStageCap(u, e.target.value === "" ? null : Number(e.target.value))
                          }
                          className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                        >
                          <option value="">Stage: plan ({u.planStageSeats})</option>
                          {[1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25].map((n) => (
                            <option key={n} value={n}>
                              Stage: {n}
                              {n > u.planStageSeats ? " (over plan)" : ""}
                            </option>
                          ))}
                        </select>
                      )}

                      {u.canHost && (
                        <select
                          aria-label="People in a meeting"
                          title="People in one meeting at once, host included. Webinar stages are separate."
                          value={u.meetingCap ?? ""}
                          disabled={busy === u.id}
                          onChange={(e) =>
                            void setMeetingCap(u, e.target.value === "" ? null : Number(e.target.value))
                          }
                          className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                        >
                          <option value="">Meeting: plan ({u.planMeetingSeats})</option>
                          {[2, 5, 10, 15, 20, 25, 30, 40, 50].map((n) => (
                            <option key={n} value={n}>
                              Meeting: {n}
                              {n > u.planMeetingSeats ? " (over plan)" : ""}
                            </option>
                          ))}
                        </select>
                      )}

                      {/* Only with a second video server configured; webinars already
                       * pinned to a server never move, so this only steers new ones. */}
                      {u.canHost && sfuProjects.length > 1 && (
                        <select
                          aria-label="Video server"
                          title={`Video server for this host's new webinars. Cost: ${COSTS.videoServer}`}
                          value={u.sfuProject ?? ""}
                          onChange={(e) => void setVideoServer(u, e.target.value)}
                          className="rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                        >
                          <option value="">Default video server</option>
                          {sfuProjects.map((p) => (
                            <option
                              key={p.id}
                              value={p.id}
                              disabled={!p.enabled && p.id !== u.sfuProject}
                            >
                              {p.label}
                              {p.enabled ? "" : " (not taking new webinars)"}
                            </option>
                          ))}
                        </select>
                      )}

                      {u.trialFlag && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn-soft px-2 py-0.5 text-[11.5px] text-warn"
                          title={u.trialFlag}
                        >
                          Trial review
                          <button
                            type="button"
                            className="font-medium underline-offset-2 hover:underline"
                            onClick={() => void clearTrialFlag(u)}
                          >
                            Clear flag
                          </button>
                        </span>
                      )}
                      {u.trialExemption ? (
                        <span className="text-[11.5px] text-ink-3">Another trial allowed</span>
                      ) : (
                        <button
                          type="button"
                          className="text-[11.5px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                          onClick={() => void allowTrial(u)}
                        >
                          Allow another trial
                        </button>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setConfirmDelete(u)}
                    disabled={isSelf}
                    title={isSelf ? "You can't delete your own account" : "Delete account"}
                    className="rounded-lg px-2 py-1.5 text-[12px] font-medium text-live transition-colors hover:bg-live-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-live/40"
                  >
                    Delete
                  </button>

                  {/* Catalogue switches stay host-only: they act on a webinar this
                      account would create. CDN broadcast used to sit in the header
                      for every account, and that patch is still accepted for a
                      non-host, so the list is shown either way. */}
                  {kind === "customer" && <div className="w-full">
                    <AccountFeatures
                      user={u}
                      tiers={tiers}
                      onFeatures={(features, featureOverrides) =>
                        setUsers((prev) =>
                          (prev ?? []).map((row) =>
                            row.id === u.id ? { ...row, features, featureOverrides } : row,
                          ),
                        )
                      }
                    />
                    {u.canHost && <AccountCosts user={u} />}
                  </div>}
                </div>
              );
            })}
            <ListPager page={view.page} pages={view.pages} onPage={setPageIndex} />
          </div>
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle>Administrators</SectionTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Admins are set with the{" "}
          <code className="font-mono text-[12px]">ADMIN_EMAILS</code>{" "}
          environment variable on the server, as a comma-separated list, and
          applied when the API restarts. There is no button for it on purpose: a
          privilege that can be granted through the app can be granted by anyone
          who takes over an admin account.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Removing an address from that list demotes the account on the next
          restart, so the variable always describes who the admins <em>are</em>.
        </p>
      </Card>

      <ConfirmModal
        open={confirmDelete !== null}
        busy={deleting}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void deleteAccount(confirmDelete)}
        title={`Delete ${confirmDelete?.name || confirmDelete?.email || "this account"}?`}
        body="This removes the account entirely. Registrations, panelist seats and notifications tied to it go with it. Refused if it still hosts any webinar — delete those first."
        confirmLabel="Delete account"
      />

      <ConfirmModal
        open={confirmMove !== null}
        busy={confirmMove !== null && busy === confirmMove.id}
        onClose={() => setConfirmMove(null)}
        onConfirm={() => confirmMove && void moveAccount(confirmMove, "audience")}
        title={`Move ${confirmMove?.name || confirmMove?.email || "this account"} to webinar audience?`}
        body="They leave the customer list and appear under Webinar audience. Nothing else about the account changes, and you can move them back."
        confirmLabel="Move to audience"
      />
    </div>
  );
}

/* The per-account switches: what this customer has bought.
 *
 * Rendered from `config.featureCatalogue` and never from a list written here.
 * The server owns the key, the label AND the sentence explaining each switch,
 * which is what stops this screen from describing a feature differently to the
 * way it behaves — and means a feature added to the API appears here without a
 * frontend change.
 *
 * One request per switch, stating the state it should end in. Two admins on two
 * screens can then work at the same time without either of them overwriting a
 * decision about a switch they never touched, and a retried request cannot
 * toggle something back.
 *
 * Instant webinar is one of those catalogue switches, in the server's order.
 */
function AccountFeatures({
  user,
  tiers,
  onFeatures,
}: {
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  onFeatures: (features: string[], overrides: Record<string, boolean>) => void;
}) {
  const { featureCatalogue, featureGroups } = useAppConfig();
  const { notify } = useToast();
  /* Keyed by feature rather than a single boolean: an admin switching two things
   * on in quick succession should not have the second switch look dead because
   * the first is still in flight. */
  const [busy, setBusy] = useState<string | null>(null);

  const switches = accountFeatureRows(user.canHost, featureCatalogue);
  if (switches.length === 0) return null;

  const onCount = accountFeaturesOnCount(switches, user.features);
  const grouped = groupFeatureRows(switches, featureGroups);

  /* A whole group to one state in one request (PUT …/features): all on, all off, or every
   * switch back to the plan's default. */
  async function setGroup(group: AccountFeatureGroup, state: OverrideState) {
    setBusy(`group:${group.key}`);
    try {
      const updated = await api.setUserFeatures(user.id, bulkGrants(group.rows, state));
      onFeatures(
        updated.features,
        withOverrides(user.featureOverrides, group.rows.map((r) => r.id), state),
      );
      notify(
        `${group.label}: ${state === "inherit" ? "plan defaults" : state === "on" ? "all on" : "all off"} for ${user.name || user.email}.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setFeature(key: string, state: OverrideState) {
    setBusy(key);
    try {
      const updated = await api.setUserFeatureOverride(
        user.id,
        key,
        state === "inherit" ? null : state === "on",
      );
      // The features as the server now describes them, rather than this screen's
      // guess at the new set — the two cannot then drift.
      onFeatures(updated.features, withOverride(user.featureOverrides, key, state));
      if (key === FeatureInstantWebinar) {
        const on = updated.features.includes(key);
        notify(
          on
            ? `Instant meetings/webinars enabled for ${user.name || user.email}.`
            : `Instant meetings/webinars disabled for ${user.name || user.email}.`,
          "ok",
        );
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Disclosure summary={`Features · ${onCount} of ${switches.length} on`}>
      <div className="grid gap-4">
        {grouped.map((group) => (
          <section key={group.key} aria-label={group.label} className="grid gap-2.5">
            <div className="flex items-center justify-between gap-3 border-b border-line pb-1">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                {group.label}
              </h4>
              {group.rows.length > 1 && (
                <div className="flex shrink-0 gap-1" role="group" aria-label={`Set every ${group.label} switch`}>
                  {(
                    [
                      ["on", "All on"],
                      ["off", "All off"],
                      ["inherit", "Plan default"],
                    ] as const
                  ).map(([state, label]) => (
                    <button
                      key={state}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setGroup(group, state)}
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {group.rows.map((row) => (
              <FeatureToggle
                key={`${row.source}:${row.id}`}
                row={row}
                user={user}
                tiers={tiers}
                needs={unmetRequirements(row, user.features, featureCatalogue)}
                disabled={busy !== null}
                onFeature={setFeature}
              />
            ))}
          </section>
        ))}
      </div>
    </Disclosure>
  );
}

function FeatureToggle({
  row,
  user,
  tiers,
  needs,
  disabled,
  onFeature,
}: {
  row: AccountFeatureRow;
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  /* Labels of the switches this one needs that are off: it is not in effect until they are on. */
  needs: string[];
  disabled: boolean;
  onFeature: (key: string, state: OverrideState) => Promise<void>;
}) {
  /* Plan, then this account's override: Inherit says what the plan gives, so an
   * admin can see whether forcing it on or off changes anything. */
  const state = overrideState(user.featureOverrides, row.id);
  const inherited = planIncludes(tiers, user.plan, row.id);
  const inheritLabel =
    inherited === null ? "Plan default" : `Plan default (${inherited ? "on" : "off"})`;
  const effective = (user.features ?? []).includes(row.id);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink-1">
          {row.id === FeatureAI && <SparklesIcon className="mr-1 inline size-3.5 align-[-2px] text-brand" />}
          {row.label}{" "}
          <span className={`text-[11px] font-normal ${effective ? "text-ok" : "text-ink-3"}`}>
            · {effective ? "on" : "off"}
          </span>
          {needs.length > 0 && (
            <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-px text-[10.5px] font-normal text-warn">
              needs {needs.join(" + ")}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{row.description}</p>
        {FEATURE_COSTS[row.id] && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">
            Cost: {FEATURE_COSTS[row.id]}
          </p>
        )}
      </div>
      <select
        aria-label={`${row.label} for this account`}
        value={state}
        disabled={disabled}
        onChange={(e) => void onFeature(row.id, e.target.value as OverrideState)}
        className="shrink-0 rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="inherit">{inheritLabel}</option>
        <option value="on">Always on</option>
        <option value="off">Always off</option>
      </select>
    </div>
  );
}

/* What this account's settings cost us, in one place, so whoever changes one of them sees the
 * bill it can run up. The numbers live in lib/admin-costs.ts. */
function AccountCosts({ user }: { user: AdminUser }) {
  const { featureCatalogue } = useAppConfig();
  const on = (key: string) => (user.features ?? []).includes(key);
  const label = (key: string) => featureCatalogue.find((f) => f.key === key)?.label ?? key;
  const rows: [string, string][] = [
    ["Hosting", COSTS.canHost],
    [`People on stage: ${user.stageSeats}${user.stageCap ? " (custom)" : ""}`, stageCostText(user.stageSeats)],
    [`Plan: ${user.plan ? PLAN_LABEL[user.plan] : "launch default"}`, COSTS.plan],
    ["Video server", COSTS.videoServer],
    ["Max meeting duration", COSTS.maxDuration],
    ["Media storage", COSTS.mediaQuota],
  ];
  for (const [key, text] of Object.entries(FEATURE_COSTS)) {
    if (on(key)) rows.push([`${label(key)} (on)`, text]);
  }
  return (
    <Disclosure summary="Cost of these settings">
      <p className="text-[12px] text-ink-3">
        Estimates of what this account can cost us, at list prices. Turning a setting up applies to
        every webinar this host runs.
      </p>
      <dl className="mt-2 space-y-1.5">
        {rows.map(([label, text]) => (
          <div key={label}>
            <dt className="text-[12px] font-medium text-ink-1">{label}</dt>
            <dd className="text-[12px] leading-relaxed text-ink-2">{text}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

/* Which features each plan includes, for every account on it without an override.
 *
 * Edited as a grid and saved whole: the server replaces the matrix in one
 * transaction, so nobody reads half of a save. Attendee caps are not here — they
 * are part of the plan's price (types.PlanAttendeeCap). */
const MB = 1 << 20;

/** The deployment's default media limit, as the server reports it on any account
 *  without its own (MEDIA_QUOTA_DEFAULT_MB), else the built-in default. */
function defaultMediaLimit(rows: AdminUser[]): number {
  const plain = rows.find((r) => r.mediaQuotaBytes === undefined && r.mediaLimitBytes > 0);
  return plain?.mediaLimitBytes ?? DefaultMediaQuotaMB * MB;
}

function mbText(bytes: number): string {
  return `${(bytes / MB).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "Media storage": what the account's media library holds, of its limit, with the
 *  limit editable in MB. Blank is the default. Saved on blur or Enter. */
function MediaQuotaField({
  user: u,
  defaultBytes,
  disabled,
  onSave,
}: {
  user: AdminUser;
  defaultBytes: number;
  disabled: boolean;
  onSave: (mb: number | null) => void;
}) {
  const current = u.mediaQuotaBytes === undefined ? "" : String(Math.round((u.mediaQuotaBytes / MB) * 10) / 10);
  // The row is keyed by the saved limit, so a save starts the draft over.
  const [draft, setDraft] = useState(current);
  const over = u.mediaUsedBytes > u.mediaLimitBytes;
  const max = MaxMediaQuotaMB;

  function commit() {
    const v = draft.trim();
    if (v === current) return;
    if (v === "") return onSave(null);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) {
      setDraft(current);
      return;
    }
    onSave(n);
  }

  return (
    <label
      className="flex items-center gap-1.5 text-[12px] text-ink-2"
      title={`Media storage: ${mbText(u.mediaUsedBytes)} used of ${mbText(u.mediaLimitBytes)}. Blank uses the default (${mbText(defaultBytes)}); up to ${max / 1024} GB.`}
    >
      <span className={over ? "text-live" : ""}>
        Media {mbText(u.mediaUsedBytes)} /
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={0.1}
        max={max}
        step="any"
        aria-label="Media storage limit in MB"
        placeholder={`${defaultBytes / MB} (default)`}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-[92px] rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      <span>MB</span>
    </label>
  );
}

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
        TIER_COLUMNS.map((c) => ({ plan: c.plan, features: [...(draft[c.plan] ?? [])] })),
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
          override under Accounts → Features.
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
                      <input
                        type="checkbox"
                        aria-label={`${f.label} in ${c.label}`}
                        checked={draft[c.plan]?.has(f.key) ?? false}
                        onChange={(e) => toggle(c.plan, f.key, e.target.checked)}
                        className="size-4 cursor-pointer accent-brand"
                      />
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

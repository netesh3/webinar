"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  accountFeatureRows,
  accountFeaturesOnCount,
  CDN_BROADCAST_ROW_ID,
  overrideState,
  planIncludes,
  withOverride,
  type AccountFeatureRow,
  type OverrideState,
} from "@/lib/admin-account-features";
import {
  FeatureInstantWebinar,
  PlanBusiness,
  PlanEnterprise,
  PlanLaunchAttendees,
  PlanProfessional,
  type AdminUser,
  type Plan,
  type PlanFeatures,
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
import { useAppConfig, useSession, useToast } from "./providers";
import {
  Alert,
  ConfirmModal,
  Disclosure,
  Spinner,
  Tabs,
  Toggle,
} from "./controls";
import { DateRangeField } from "./date-picker";
import { Avatar, Badge, ButtonLink, Card, Empty, SectionTitle } from "./ui";
import { AdminDashboard, type WebinarStatusFilter } from "./admin-dashboard";
import { ArrowLeftIcon } from "./icons";

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

const ADMIN_TABS = ["dashboard", "accounts", "plans", "webinars"] as const;
type AdminTab = (typeof ADMIN_TABS)[number];

const PAGE_SIZE = 10;

export function AdminScreen() {
  const [tab, setTab] = useState<AdminTab>("dashboard");
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
        }}
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
      </div>
    </div>
  );
}

function AdminAccounts() {
  const { account } = useSession();
  const { notify } = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  const load = useCallback(() => {
    api
      .adminUsers()
      .then((rows) => {
        setUsers(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load accounts.");
      });
    api
      .planFeatures()
      .then((body) => setTiers(body.tiers))
      .catch(() => setTiers(null));
  }, []);

  useEffect(load, [load]);

  /* Filtered in the browser rather than re-querying per keystroke.
   *
   * The server takes a `q` and this deployment has seven accounts. Sending a request per
   * keystroke to filter a list that fits on one screen is a round trip for nothing; the
   * server-side filter is there for when this grows, and switching to it is a one-line
   * change to the load call. */
  const shown = useMemo(() => {
    if (!users) return null;
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
    );
  }, [users, query]);

  const view = useMemo(
    () => paginate(shown ?? [], PAGE_SIZE, pageIndex),
    [shown, pageIndex],
  );

  async function setHost(u: AdminUser, canHost: boolean) {
    setBusy(u.id);
    try {
      await api.setHostCapability(u.id, canHost);
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

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <input
            className="field max-w-sm flex-1"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPageIndex(0);
            }}
            aria-label="Search accounts"
          />
          <span className="text-[12.5px] text-ink-3">
            {hosts} of {users?.length ?? 0} can host
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
            hint="Try a different name or email."
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
                      {u.canCdnBroadcast && <Badge tone="ok">CDN Broadcast</Badge>}
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
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>

                  {busy === u.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Toggle
                        checked={u.canHost}
                        /* Self-revoke is refused by the server too — this only saves the
                         * round trip. It is the one lockout with no way back from inside
                         * the app: the toggle you would use to restore it is this one. */
                        disabled={isSelf && u.canHost}
                        onChange={(next) => void setHost(u, next)}
                        label="Can host"
                      />

                      {/* Max meeting duration — only shown for hosts */}
                      {u.canHost && (
                        <select
                          aria-label="Max meeting duration"
                          title="Max meeting duration"
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
                        <select
                          aria-label="Plan"
                          title="Plan (sets the attendee cap)"
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
                  <div className="w-full">
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
                      onCdnBroadcast={(canCdnBroadcast) =>
                        setUsers((prev) =>
                          (prev ?? []).map((row) =>
                            row.id === u.id ? { ...row, canCdnBroadcast } : row,
                          ),
                        )
                      }
                    />
                  </div>
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
 * CDN broadcast is not: it is still canCdnBroadcast, on its own patch.
 */
function AccountFeatures({
  user,
  tiers,
  onFeatures,
  onCdnBroadcast,
}: {
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  onFeatures: (features: string[], overrides: Record<string, boolean>) => void;
  onCdnBroadcast: (canCdnBroadcast: boolean) => void;
}) {
  const { featureCatalogue } = useAppConfig();
  const { notify } = useToast();
  /* Keyed by feature rather than a single boolean: an admin switching two things
   * on in quick succession should not have the second switch look dead because
   * the first is still in flight. */
  const [busy, setBusy] = useState<string | null>(null);

  const switches = accountFeatureRows(user.canHost, featureCatalogue);
  if (switches.length === 0) return null;

  const onCount = accountFeaturesOnCount(
    switches,
    user.features,
    user.canCdnBroadcast,
  );

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
            ? `Instant webinar enabled for ${user.name || user.email}.`
            : `Instant webinar disabled for ${user.name || user.email}.`,
          "ok",
        );
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function setCdnBroadcast(enabled: boolean) {
    setBusy(CDN_BROADCAST_ROW_ID);
    try {
      await api.setCdnBroadcastCapability(user.id, enabled);
      onCdnBroadcast(enabled);
      notify(
        enabled
          ? `CDN broadcast mode enabled for ${user.name || user.email}.`
          : `CDN broadcast mode disabled for ${user.name || user.email}.`,
        "ok",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Disclosure summary={`Features · ${onCount} of ${switches.length} on`}>
      <div className="grid gap-2.5">
        {switches.map((row) => (
          <FeatureToggle
            key={`${row.source}:${row.id}`}
            row={row}
            user={user}
            tiers={tiers}
            disabled={busy !== null}
            onFeature={setFeature}
            onCdnBroadcast={setCdnBroadcast}
          />
        ))}
      </div>
    </Disclosure>
  );
}

function FeatureToggle({
  row,
  user,
  tiers,
  disabled,
  onFeature,
  onCdnBroadcast,
}: {
  row: AccountFeatureRow;
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  disabled: boolean;
  onFeature: (key: string, state: OverrideState) => Promise<void>;
  onCdnBroadcast: (enabled: boolean) => Promise<void>;
}) {
  if (row.source === "cdn_broadcast") {
    return (
      <Toggle
        checked={user.canCdnBroadcast}
        disabled={disabled}
        onChange={(next) => void onCdnBroadcast(next)}
        label={row.label}
        description={row.description}
      />
    );
  }
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
          {row.label}{" "}
          <span className={`text-[11px] font-normal ${effective ? "text-ok" : "text-ink-3"}`}>
            · {effective ? "on" : "off"}
          </span>
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{row.description}</p>
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
                    <div className="font-medium text-ink-1">{f.label}</div>
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

/* Every webinar on the instance — completed and upcoming, filterable by
 * status and by date — with the one action an admin has here that a host
 * does not: deleting a webinar that isn't theirs.
 *
 * A separate component, and a separate fetch, from the accounts list above:
 * the two lists have nothing in common and a host running a hundred webinars
 * must not make the accounts table (used every time an admin checks a single
 * person) wait on it.
 */
const STATUSES = [
  { value: "", label: "All" },
  { value: "scheduled", label: "Upcoming" },
  { value: "live", label: "Live" },
  { value: "ended", label: "Completed" },
  { value: "draft", label: "Draft" },
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /* Reset with the filter. Each status chip, date range and search is its own
   * list: staying on page 3 of All and then opening Live should not come back
   * to page 3. A delete that only shortens the current list is left to
   * paginate(), which clamps. */
  const [pageIndex, setPageIndex] = useState(0);

  const load = useCallback(() => {
    api
      .adminWebinars({
        status: status || undefined,
        from: from || undefined,
        to: to || undefined,
        q: query || undefined,
      })
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load webinars.");
      });
  }, [status, from, to, query]);

  useEffect(load, [load]);

  const view = useMemo(
    () => paginate(rows ?? [], PAGE_SIZE, pageIndex),
    [rows, pageIndex],
  );

  async function remove(slug: string) {
    setDeleting(true);
    try {
      await api.adminDeleteWebinar(slug);
      setRows((prev) => (prev ?? []).filter((w) => w.id !== slug));
      setConfirmSlug(null);
      notify("Webinar deleted.", "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not delete that webinar.", "error");
    } finally {
      setDeleting(false);
    }
  }

  const target = rows?.find((w) => w.id === confirmSlug) ?? null;

  return (
    <div>
      <div className="mb-3">
        <SectionTitle>Webinars</SectionTitle>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          Every webinar on this instance, across every host. Filter by status
          or by date to find completed sessions or what&apos;s coming up.
        </p>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-1 flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => {
                  if (s.value !== status) setPageIndex(0);
                  setStatus(s.value);
                }}
                aria-pressed={status === s.value}
                className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  status === s.value
                    ? "bg-brand-soft text-brand"
                    : "text-ink-2 hover:bg-surface-2"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <DateRangeField
            from={from}
            to={to}
            ariaLabel="Filter webinars by date"
            onChange={(nextFrom, nextTo) => {
              setFrom(nextFrom);
              setTo(nextTo);
              setPageIndex(0);
            }}
          />
        </div>

        <input
          className="field mb-3 w-full max-w-sm"
          placeholder="Search by topic…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPageIndex(0);
          }}
          aria-label="Search webinars"
        />

        {error && <Alert tone="error">{error}</Alert>}

        {rows === null ? (
          <div className="grid gap-2">
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
            <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title="No webinars match"
            hint="Try a wider date range or a different status."
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

                {deleting && confirmSlug === w.id ? (
                  <Spinner className="size-4" />
                ) : (
                  <div className="flex items-center gap-1.5">
                    {/* Read-only: the host detail page itself still gates every
                        action (mute, end, remove a participant, …) on being the
                        true host or a co-host — see requireOwnership's admin
                        branch in api/internal/api/auth.go. An admin lands on the
                        same page a host would, sees the same details, recordings
                        and transcripts, but every button that changes a live
                        session simply won't work for them. */}
                    <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                      View
                    </ButtonLink>
                    <button
                      type="button"
                      onClick={() => setConfirmSlug(w.id)}
                      className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-live transition-colors hover:bg-live-soft outline-none focus-visible:ring-2 focus-visible:ring-live/40"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
            <ListPager page={view.page} pages={view.pages} onPage={setPageIndex} />
          </div>
        )}
      </Card>

      <ConfirmModal
        open={confirmSlug !== null}
        busy={deleting}
        onClose={() => setConfirmSlug(null)}
        onConfirm={() => confirmSlug && void remove(confirmSlug)}
        title={`Delete "${target?.topic ?? "this webinar"}"?`}
        body="This permanently removes the webinar, every registration, chat message, poll, recording and question attached to it. If it's live right now, the room is closed too."
        confirmLabel="Delete webinar"
      />
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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  ADMIN_FEATURE_GROUPS,
  PLAN_NAMES,
  adminFeatureLabel,
  adminSwitchGroups,
  limitText,
  planGives,
  switchState,
  switchStateText,
  type AdminSwitch,
  type AdminSwitchGroup,
  type SwitchState,
} from "@/lib/admin-feature-groups";
import { withOverride, withOverrides } from "@/lib/admin-account-features";
import {
  ACCOUNT_ROLE_FILTERS,
  ACCOUNT_ROLE_LABEL,
  countAccountRoles,
  filterAccounts,
  type AccountRoleFilter,
} from "@/lib/admin-accounts-filter";
import { paginate } from "@/lib/paginate";
import {
  DefaultMediaQuotaMB,
  MaxMediaQuotaMB,
  MaxMeetingCapOverride,
  MaxStageCapOverride,
  PlanBasic,
  PlanBusiness,
  PlanEnterprise,
  PlanProfessional,
  type AccountKind,
  type AdminAccountCounts,
  type AdminUser,
  type FeatureGrant,
  type Plan,
  type PlanFeatures,
  type SFUProjectOption,
} from "@/lib/api-types";
import { useAppConfig, useSession, useToast } from "./providers";
import { Alert, ConfirmModal, Spinner, Toggle } from "./controls";
import { Avatar, Badge, Card, Empty } from "./ui";
import { RecordingStorageField } from "./admin-recording-storage";
import { ArrowLeftIcon } from "./icons";

/* Admin → Accounts (2 Nov 2026): a searchable list on the left, the account on the right (on a
 * phone, one then the other). The account panel is the plan and subscription, the limits with
 * plan default against override, then every switch grouped and named as the pricing page sells
 * them (lib/admin-feature-groups.ts), each "From plan", "On for this host" or "Off for this
 * host". The server owns each switch's description; overrides are one request per switch, so
 * two admins never overwrite each other's decisions. */

const PAGE_SIZE = 12;
const MB = 1 << 20;

// The plan select, in the order the plans are sold.
const PLAN_OPTIONS: Plan[] = [PlanBasic, PlanProfessional, PlanBusiness, PlanEnterprise];

const STAGE_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 75, 100];
const MEETING_CHOICES = [2, 5, 10, 15, 20, 25, 30, 40, 50, 100, 150, 200, 300];
const DURATION_CHOICES = [60, 120, 180, 240, 360, 480];

const selectClass =
  "w-full rounded-md border border-line bg-surface-0 px-2 py-1.5 text-[13px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

function who(u: AdminUser): string {
  return u.name || u.email;
}

export function AdminAccounts() {
  const { notify } = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [kind, setKind] = useState<AccountKind>("customer");
  const [counts, setCounts] = useState<AdminAccountCounts | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<AccountRoleFilter>("all");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<PlanFeatures[] | null>(null);
  const [sfuProjects, setSfuProjects] = useState<SFUProjectOption[]>([]);

  // Not async, with the writes inside .then(), for react-hooks/set-state-in-effect.
  const load = useCallback(() => {
    api
      .adminUsers("", kind)
      .then((rows) => {
        setUsers(rows);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load accounts."));
    api.adminAccountCounts().then(setCounts).catch(() => setCounts(null));
    api.planFeatures().then((b) => setTiers(b.tiers)).catch(() => setTiers(null));
    api.sfuProjects().then((b) => setSfuProjects(b.projects)).catch(() => setSfuProjects([]));
  }, [kind]);
  useEffect(load, [load]);

  const shown = useMemo(
    () => (users ? filterAccounts(users, query, roleFilter, pinned) : null),
    [users, query, roleFilter, pinned],
  );
  const roleCounts = useMemo(() => countAccountRoles(users ?? [], query), [users, query]);
  const view = useMemo(() => paginate(shown ?? [], PAGE_SIZE, pageIndex), [shown, pageIndex]);
  const selected = users?.find((u) => u.id === selectedId) ?? null;

  const patch = useCallback((id: string, p: Partial<AdminUser>) => {
    setUsers((prev) => (prev ?? []).map((row) => (row.id === id ? { ...row, ...p } : row)));
  }, []);

  const removed = useCallback((id: string) => {
    setUsers((prev) => (prev ?? []).filter((row) => row.id !== id));
    setSelectedId(null);
  }, []);

  function chooseKind(next: AccountKind) {
    if (next === kind) return;
    setKind(next);
    setUsers(null);
    setRoleFilter("all");
    setPinned(new Set());
    setPageIndex(0);
    setSelectedId(null);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold">Accounts</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            Hosting, plans, limits and every switch for one account. Admins come from ADMIN_EMAILS on the server.
          </p>
        </div>
        <div role="tablist" aria-label="Account lists" className="flex gap-1.5">
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
              onClick={() => chooseKind(value)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                kind === value ? "border-brand/40 bg-brand-soft text-brand" : "border-line text-ink-2 hover:bg-surface-2"
              }`}
            >
              {label}
              {n !== undefined ? ` (${n})` : ""}
            </button>
          ))}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        {/* The list. On a phone it gives way to the open account. */}
        <Card className={`p-3 ${selected ? "hidden lg:block" : ""}`}>
          <input
            className="field w-full"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPinned(new Set());
              setPageIndex(0);
            }}
            aria-label="Search accounts"
          />
          {kind === "customer" && (
            <div role="group" aria-label="Filter accounts by role" className="mt-2 flex flex-wrap gap-1">
              {ACCOUNT_ROLE_FILTERS.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={roleFilter === r}
                  onClick={() => {
                    setRoleFilter(r);
                    setPinned(new Set());
                    setPageIndex(0);
                  }}
                  className={`rounded-md px-2 py-1 text-[12px] font-medium ${
                    roleFilter === r ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  {ACCOUNT_ROLE_LABEL[r]} <span className="tabular-nums text-ink-3">{users ? roleCounts[r] : "–"}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3">
            {shown === null ? (
              <div className="grid gap-2">
                <div className="h-12 animate-pulse rounded-lg bg-surface-2" />
                <div className="h-12 animate-pulse rounded-lg bg-surface-2" />
              </div>
            ) : shown.length === 0 ? (
              <Empty title="No accounts match" hint="Try a different name or email." />
            ) : (
              <ul className="grid gap-1" aria-label="Accounts">
                {view.items.map((u) => (
                  <li key={u.id}>
                    <AccountRow user={u} kind={kind} active={u.id === selectedId} onOpen={() => setSelectedId(u.id)} />
                  </li>
                ))}
              </ul>
            )}
            {shown && view.pages > 1 && (
              <div className="mt-3 flex items-center justify-between text-[12px] text-ink-3">
                <button
                  type="button"
                  disabled={view.page === 0}
                  onClick={() => setPageIndex(view.page - 1)}
                  className="rounded-md px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
                >
                  Previous
                </button>
                <span>
                  Page {view.page + 1} of {view.pages}
                </span>
                <button
                  type="button"
                  disabled={view.page >= view.pages - 1}
                  onClick={() => setPageIndex(view.page + 1)}
                  className="rounded-md px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </Card>

        {selected ? (
          <AccountPanel
            key={selected.id}
            user={selected}
            kind={kind}
            users={users ?? []}
            tiers={tiers}
            sfuProjects={sfuProjects}
            onPatch={(p) => {
              patch(selected.id, p);
              if (roleFilter !== "all") setPinned((prev) => new Set(prev).add(selected.id));
            }}
            onReload={load}
            onRemoved={() => removed(selected.id)}
            onMoved={(to) => {
              removed(selected.id);
              setCounts((c) =>
                c
                  ? to === "customer"
                    ? { customers: c.customers + 1, audience: Math.max(0, c.audience - 1) }
                    : { customers: Math.max(0, c.customers - 1), audience: c.audience + 1 }
                  : c,
              );
            }}
            onClose={() => setSelectedId(null)}
            notify={notify}
          />
        ) : (
          <Card className="hidden p-8 text-center text-[13px] text-ink-3 lg:block">
            Pick an account to see its plan, limits and switches.
          </Card>
        )}
      </div>
    </div>
  );
}

function AccountRow({
  user: u,
  kind,
  active,
  onOpen,
}: {
  user: AdminUser;
  kind: AccountKind;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        active ? "bg-brand-soft" : "hover:bg-surface-2"
      }`}
    >
      <Avatar
        person={{ id: u.id, name: u.name, title: u.title ?? "", org: u.org ?? "", initials: u.initials, hue: u.hue }}
        size={30}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{u.name || u.email}</span>
        <span className="block truncate text-[11.5px] text-ink-3">{u.email}</span>
      </span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {kind === "customer" && <Badge tone={u.plan ? "brand" : undefined}>{PLAN_NAMES[u.plan ?? ""]}</Badge>}
        {kind === "audience" && <Badge>Audience</Badge>}
        {u.canHost && <Badge tone="ok">Host</Badge>}
        {u.isAdmin && <Badge tone="brand">Admin</Badge>}
        {u.trialFlag && <Badge tone="warn">Review</Badge>}
      </span>
    </button>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[12.5px] font-medium text-ink-1">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

function AccountPanel({
  user: u,
  kind,
  users,
  tiers,
  sfuProjects,
  onPatch,
  onReload,
  onRemoved,
  onMoved,
  onClose,
  notify,
}: {
  user: AdminUser;
  kind: AccountKind;
  users: AdminUser[];
  tiers: PlanFeatures[] | null;
  sfuProjects: SFUProjectOption[];
  onPatch: (p: Partial<AdminUser>) => void;
  onReload: () => void;
  onRemoved: () => void;
  onMoved: (to: AccountKind) => void;
  onClose: () => void;
  notify: (text: string, tone?: "ok" | "error" | "info") => void;
}) {
  const { account } = useSession();
  const isSelf = u.id === account?.id;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);

  async function run(tag: string, fn: () => Promise<void>) {
    setBusy(tag);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  const setHost = (canHost: boolean) =>
    run("host", async () => {
      await api.setHostCapability(u.id, canHost);
      onPatch({ canHost });
      notify(canHost ? `${who(u)} can now host webinars.` : `Hosting removed from ${who(u)}.`, "ok");
    });
  const setPlan = (plan: Plan | "") =>
    run("plan", async () => {
      const updated = await api.setUserPlan(u.id, plan);
      onPatch({ plan: plan || undefined, features: updated.features });
      notify(plan ? `${who(u)} is on ${PLAN_NAMES[plan]}.` : `${who(u)} has no plan.`, "ok");
      onReload(); // the plan sets the caps; the server computes them
    });
  const setStage = (stageCap: number | null) => {
    const next = stageCap ?? u.planStageSeats;
    if (next > u.planStageSeats && !window.confirm(`Allow ${next} people on stage for ${who(u)}? Their plan allows ${u.planStageSeats}.`)) return;
    void run("stage", async () => {
      await api.setUserStageCap(u.id, stageCap);
      onPatch({ stageCap: stageCap ?? undefined, stageSeats: next });
      notify(stageCap === null ? `${who(u)} is back on the plan's stage.` : `${who(u)} may have ${stageCap} on stage.`, "ok");
    });
  };
  const setMeeting = (meetingCap: number | null) => {
    const next = meetingCap ?? u.planMeetingSeats;
    if (next > u.planMeetingSeats && !window.confirm(`Allow meetings of ${next} people for ${who(u)}? Their plan allows ${u.planMeetingSeats}.`)) return;
    void run("meeting", async () => {
      await api.setUserMeetingCap(u.id, meetingCap);
      onPatch({ meetingCap: meetingCap ?? undefined, meetingSeats: next });
      notify(meetingCap === null ? `${who(u)} is back on the plan's meeting size.` : `${who(u)} may hold meetings of ${meetingCap}.`, "ok");
    });
  };
  const setDuration = (maxDurationMin: number | null) =>
    run("duration", async () => {
      await api.setUserMaxDuration(u.id, maxDurationMin);
      onPatch({ maxDurationMin: maxDurationMin ?? undefined });
      notify(maxDurationMin ? `Max duration for ${who(u)}: ${maxDurationMin} minutes.` : `Max duration for ${who(u)} is the default.`, "ok");
    });
  const setMedia = (mb: number | null) =>
    run("media", async () => {
      const saved = await api.setUserMediaQuota(u.id, mb === null ? null : Math.round(mb * MB));
      onPatch({ mediaQuotaBytes: saved.mediaQuotaBytes, mediaLimitBytes: saved.mediaQuotaBytes ?? defaultMediaLimit(users) });
      notify(mb === null ? `WhatsApp media for ${who(u)} is the default.` : `WhatsApp media for ${who(u)}: ${mb} MB.`, "ok");
    });
  const setServer = (project: string) =>
    run("server", async () => {
      await api.setUserSFU(u.id, project);
      onPatch({ sfuProject: project || undefined });
      notify(`${who(u)}'s new webinars will use ${sfuProjects.find((p) => p.id === project)?.label ?? "the default video server"}.`, "ok");
    });
  const allowTrial = () =>
    run("trial", async () => {
      await api.allowAnotherTrial(u.id);
      onPatch({ trialExemption: true });
      notify(`${who(u)} can take one more free trial.`, "ok");
    });
  const clearFlag = () =>
    run("trial", async () => {
      await api.clearTrialFlags(u.id);
      onPatch({ trialFlag: undefined });
      notify(`Trial review cleared for ${who(u)}.`, "ok");
    });
  const move = (to: AccountKind) =>
    run("move", async () => {
      await api.setAccountKind(u.id, to);
      setConfirmMove(false);
      onMoved(to);
      notify(to === "customer" ? `${who(u)} moved to customers.` : `${who(u)} moved to webinar audience.`, "ok");
    });
  const remove = () =>
    run("delete", async () => {
      await api.adminDeleteUser(u.id);
      setConfirmDelete(false);
      onRemoved();
      notify(`Deleted ${who(u)}.`, "ok");
    });

  const status = u.subscriptionStatus ? u.subscriptionStatus.replace("_", " ") : u.plan ? "Assigned by an admin" : "No subscription";

  return (
    <Card className="grid gap-4 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Back to accounts"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <Avatar
          person={{ id: u.id, name: u.name, title: u.title ?? "", org: u.org ?? "", initials: u.initials, hue: u.hue }}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold">{u.name || u.email}</h3>
            {u.isAdmin && <Badge tone="brand">Admin</Badge>}
            {isSelf && <Badge>You</Badge>}
            {!u.emailVerified && <Badge tone="warn">Email unverified</Badge>}
          </div>
          <p className="truncate text-[12px] text-ink-3">
            {[u.email, u.phone, u.webinarCount ? `${u.webinarCount} webinar${u.webinarCount === 1 ? "" : "s"}` : ""]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {kind === "audience" && u.registrationCount > 0 && (
            <p className="truncate text-[12px] text-ink-3">
              Registered for {u.registrationCount} webinar{u.registrationCount === 1 ? "" : "s"}
              {u.lastWebinarTopic ? ` · latest: ${u.lastWebinarTopic}` : ""}
            </p>
          )}
        </div>
        {busy && <Spinner className="size-4" />}
      </div>

      <Section title="Plan & account">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan" hint={`Subscription: ${status}`}>
            <select
              aria-label="Plan"
              className={selectClass}
              value={u.plan ?? ""}
              disabled={busy !== null}
              onChange={(e) => void setPlan(e.target.value as Plan | "")}
            >
              <option value="">No plan</option>
              {PLAN_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {PLAN_NAMES[p]}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid content-start gap-2">
            <Toggle
              checked={u.canHost}
              disabled={busy !== null || (isSelf && u.canHost)}
              onChange={(next) => void setHost(next)}
              label="Can host"
              description="Lets this account create webinars and meetings."
            />
          </div>
          {sfuProjects.length > 1 && (
            <Field label="Video server" hint="For this host's new webinars.">
              <select
                aria-label="Video server"
                className={selectClass}
                value={u.sfuProject ?? ""}
                disabled={busy !== null}
                onChange={(e) => void setServer(e.target.value)}
              >
                <option value="">Default video server</option>
                {sfuProjects.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== u.sfuProject}>
                    {p.label}
                    {p.enabled ? "" : " (not taking new webinars)"}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
          {u.trialFlag && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn-soft px-2 py-0.5 text-warn" title={u.trialFlag}>
              Trial review
              <button type="button" className="font-medium hover:underline" onClick={() => void clearFlag()}>
                Clear flag
              </button>
            </span>
          )}
          {u.trialExemption ? (
            <span className="text-ink-3">Another trial allowed</span>
          ) : (
            <button type="button" className="rounded-md border border-line px-2 py-1 text-ink-2 hover:bg-surface-2" onClick={() => void allowTrial()}>
              Allow another trial
            </button>
          )}
          {kind === "audience" ? (
            <button type="button" className="rounded-md border border-line px-2 py-1 text-ink-2 hover:bg-surface-2" onClick={() => void move("customer")}>
              Move to customers
            </button>
          ) : (
            !u.canHost &&
            !u.plan &&
            !u.isAdmin && (
              <button type="button" className="rounded-md border border-line px-2 py-1 text-ink-2 hover:bg-surface-2" onClick={() => setConfirmMove(true)}>
                Move to audience
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={isSelf}
            title={isSelf ? "You can't delete your own account" : "Delete account"}
            className="ml-auto rounded-md px-2 py-1 font-medium text-live hover:bg-live-soft disabled:opacity-40"
          >
            Delete account
          </button>
        </div>
      </Section>

      {kind === "customer" && (
        <Section title="Limits">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Attendees per webinar" hint="An admin can raise one webinar in the Webinars tab.">
              <p className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[13px]">
                {limitText(u.planAttendees, null, "attendees")}
              </p>
            </Field>
            <Field label="People on stage" hint={limitText(u.planStageSeats, u.stageCap, "on stage")}>
              <select
                aria-label="People on stage"
                className={selectClass}
                value={u.stageCap ?? ""}
                disabled={busy !== null}
                onChange={(e) => setStage(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Plan ({u.planStageSeats})</option>
                {STAGE_CHOICES.filter((n) => n <= MaxStageCapOverride).map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n > u.planStageSeats ? " (over plan)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="People per meeting" hint={limitText(u.planMeetingSeats, u.meetingCap, "people")}>
              <select
                aria-label="People in a meeting"
                className={selectClass}
                value={u.meetingCap ?? ""}
                disabled={busy !== null}
                onChange={(e) => setMeeting(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Plan ({u.planMeetingSeats})</option>
                {MEETING_CHOICES.filter((n) => n <= MaxMeetingCapOverride).map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n > u.planMeetingSeats ? " (over plan)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max session length" hint={u.maxDurationMin ? "Override" : "Default (3 hours)"}>
              <select
                aria-label="Max meeting duration"
                className={selectClass}
                value={u.maxDurationMin ?? ""}
                disabled={busy !== null}
                onChange={(e) => void setDuration(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Default (3h)</option>
                {DURATION_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m / 60} hour{m === 60 ? "" : "s"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Storage (uploads and recordings)">
              <RecordingStorageField user={u} onSaved={(p) => onPatch(p)} />
            </Field>
            <Field label="WhatsApp media library">
              <MediaQuotaField
                key={`${u.id}:${u.mediaQuotaBytes ?? ""}`}
                user={u}
                defaultBytes={defaultMediaLimit(users)}
                disabled={busy !== null}
                onSave={(mb) => void setMedia(mb)}
              />
            </Field>
          </div>
        </Section>
      )}

      {kind === "customer" && <AccountSwitches user={u} tiers={tiers} onPatch={onPatch} notify={notify} />}

      <ConfirmModal
        open={confirmDelete}
        busy={busy === "delete"}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title={`Delete ${who(u)}?`}
        body="This removes the account entirely. Registrations, panelist seats and notifications tied to it go with it. Refused if it still hosts any webinar — delete those first."
        confirmLabel="Delete account"
      />
      <ConfirmModal
        open={confirmMove}
        busy={busy === "move"}
        onClose={() => setConfirmMove(false)}
        onConfirm={() => void move("audience")}
        title={`Move ${who(u)} to webinar audience?`}
        body="They leave the customer list and appear under Webinar audience. Nothing else about the account changes, and you can move them back."
        confirmLabel="Move to audience"
      />
    </Card>
  );
}

/* Every switch, grouped as the pricing page sells them, with a search. Each is From plan / On /
 * Off for this host; "Reset to plan" drops the override. A group can be reset whole. */
function AccountSwitches({
  user: u,
  tiers,
  onPatch,
  notify,
}: {
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  onPatch: (p: Partial<AdminUser>) => void;
  notify: (text: string, tone?: "ok" | "error" | "info") => void;
}) {
  const { featureCatalogue } = useAppConfig();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const groups = adminSwitchGroups(featureCatalogue, query);
  const overridden = Object.keys(u.featureOverrides ?? {}).length;

  async function setOne(key: string, state: SwitchState) {
    setBusy(key);
    try {
      const updated = await api.setUserFeatureOverride(u.id, key, state === "plan" ? null : state === "on");
      onPatch({ features: updated.features, featureOverrides: withOverride(u.featureOverrides, key, state === "plan" ? "inherit" : state) });
      notify(`${adminFeatureLabel(key)}: ${state === "plan" ? "back to the plan" : state === "on" ? "on" : "off"} for ${who(u)}.`, "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function resetGroup(group: AdminSwitchGroup) {
    const keys = group.switches.map((s) => s.key).filter((k) => k in (u.featureOverrides ?? {}));
    if (keys.length === 0) return;
    setBusy(`group:${group.id}`);
    try {
      const grants: FeatureGrant[] = keys.map((k) => ({ feature: k, enabled: false, inherit: true }));
      const updated = await api.setUserFeatures(u.id, grants);
      onPatch({ features: updated.features, featureOverrides: withOverrides(u.featureOverrides, keys, "inherit") });
      notify(`${group.title}: back to the plan for ${who(u)}.`, "ok");
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title={`Switches · ${overridden} override${overridden === 1 ? "" : "s"}`}
      aside={
        <input
          className="field w-full max-w-[16rem] py-1 text-[12.5px]"
          placeholder="Find a switch…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a switch"
        />
      }
    >
      {groups.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">No switch matches.</p>
      ) : (
        <div className="grid gap-4">
          {groups.map((g) => {
            const groupOverrides = g.switches.filter((s) => s.key in (u.featureOverrides ?? {})).length;
            return (
              <div key={g.id} className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-[13px] font-semibold text-ink">{g.title}</h4>
                  {groupOverrides > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void resetGroup(g)}
                      className="text-[11.5px] font-medium text-brand hover:underline disabled:opacity-50"
                    >
                      Reset group to plan
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {g.switches.map((s) => (
                    <SwitchRow key={s.key} sw={s} user={u} tiers={tiers} busy={busy !== null} onSet={setOne} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-ink-3">
        {ADMIN_FEATURE_GROUPS.length} groups, named as the pricing page sells them. Admin only switches are on no plan.
      </p>
    </Section>
  );
}

function SwitchRow({
  sw,
  user: u,
  tiers,
  busy,
  onSet,
}: {
  sw: AdminSwitch;
  user: AdminUser;
  tiers: PlanFeatures[] | null;
  busy: boolean;
  onSet: (key: string, state: SwitchState) => Promise<void>;
}) {
  const { featureCatalogue } = useAppConfig();
  const state = switchState(u, sw.key);
  const gives = planGives(tiers, u.plan, sw.key);
  const effective = (u.features ?? []).includes(sw.key);
  const needs = sw.requires
    .filter((k) => !(u.features ?? []).includes(k))
    .map((k) => adminFeatureLabel(k) || featureCatalogue.find((f) => f.key === k)?.label || k);
  const options: [SwitchState, string][] = [
    ["plan", sw.perHost ? "Default" : "From plan"],
    ["on", "On"],
    ["off", "Off"],
  ];
  return (
    <li className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink">
          {sw.label}
          <span className={`text-[11px] font-normal ${effective ? "text-ok" : "text-ink-3"}`}>· {effective ? "on" : "off"}</span>
          {needs.length > 0 && <span className="rounded bg-surface-2 px-1.5 text-[10.5px] font-normal text-warn">needs {needs.join(" + ")}</span>}
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-3">{switchStateText(state, u.plan, gives, sw.perHost)}</p>
      </div>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label={`${sw.label} for this host`} className="inline-flex rounded-md border border-line p-0.5">
          {options.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={state === value}
              disabled={busy}
              onClick={() => state !== value && void onSet(sw.key, value)}
              className={`rounded px-2 py-0.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                state === value
                  ? value === "off"
                    ? "bg-live-soft text-live"
                    : value === "on"
                      ? "bg-ok-soft text-ok"
                      : "bg-surface-2 text-ink"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {state !== "plan" && (
          <button type="button" disabled={busy} onClick={() => void onSet(sw.key, "plan")} className="text-[11.5px] font-medium text-brand hover:underline">
            Reset to plan
          </button>
        )}
      </div>
    </li>
  );
}

/** The deployment's default media limit, as the server reports it on any account without its
 *  own (MEDIA_QUOTA_DEFAULT_MB), else the built-in default. */
function defaultMediaLimit(rows: AdminUser[]): number {
  const plain = rows.find((r) => r.mediaQuotaBytes === undefined && r.mediaLimitBytes > 0);
  return plain?.mediaLimitBytes ?? DefaultMediaQuotaMB * MB;
}

function mbText(bytes: number): string {
  return `${(bytes / MB).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** The WhatsApp media library: what it holds of its limit, the limit editable in MB. Blank is
 *  the default. Saved on blur or Enter. */
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
    <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
      <span className={over ? "text-live" : ""}>{mbText(u.mediaUsedBytes)} of</span>
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
        className="w-[110px] rounded-md border border-line bg-surface-0 px-2 py-1 text-[12.5px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      <span>MB</span>
    </span>
  );
}

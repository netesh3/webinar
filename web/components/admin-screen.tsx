"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { AdminUser, Webinar } from "@/lib/api-types";
import { formatDay, formatTimeRange, tzLabel } from "@/lib/format";
import { useAppConfig, useSession, useToast } from "./providers";
import { Alert, ConfirmModal, Disclosure, Spinner, Toggle } from "./controls";
import { Avatar, Badge, ButtonLink, Card, Empty, SectionTitle } from "./ui";

/* The admin panel: who may host, every webinar on the instance, and the two
 * things only an admin can do to either — delete an account, delete a
 * webinar that isn't theirs.
 *
 * There is still no control here for making somebody an admin, and that is
 * the design rather than a missing feature. A privilege that can be granted
 * through the UI can be granted by whoever takes over one admin account, and
 * then the boundary has bought nothing. Admins come from ADMIN_EMAILS on the
 * server, which needs access to the machine to change.
 */

export function AdminScreen() {
  const { account } = useSession();
  const { notify } = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* Not async, and the state writes are inside .then().
   *
   * react-hooks/set-state-in-effect rejects an async function called from an effect body —
   * it cannot see that everything after the first await is a later tick. Same shape as
   * useDevices in lib/media.ts. */
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

  async function setCdnBroadcast(u: AdminUser, canCdnBroadcast: boolean) {
    setBusy(u.id);
    try {
      await api.setCdnBroadcastCapability(u.id, canCdnBroadcast);
      setUsers((prev) =>
        (prev ?? []).map((row) =>
          row.id === u.id ? { ...row, canCdnBroadcast } : row,
        ),
      );
      notify(
        canCdnBroadcast
          ? `CDN broadcast mode enabled for ${u.name || u.email}.`
          : `CDN broadcast mode disabled for ${u.name || u.email}.`,
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
            onChange={(e) => setQuery(e.target.value)}
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
            {shown.map((u) => {
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

                      <Toggle
                        checked={u.canCdnBroadcast}
                        onChange={(next) => void setCdnBroadcast(u, next)}
                        label="CDN Broadcast"
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

                  {/* Hosts only. Every feature in the catalogue is something a
                      host does with their own audience, so the switches would be
                      a row of decisions with no effect on an account that cannot
                      create a webinar. */}
                  {u.canHost && (
                    <div className="w-full">
                      <AccountFeatures
                        user={u}
                        onChange={(features) =>
                          setUsers((prev) =>
                            (prev ?? []).map((row) =>
                              row.id === u.id ? { ...row, features } : row,
                            ),
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <AdminWebinars />

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
 */
function AccountFeatures({
  user,
  onChange,
}: {
  user: AdminUser;
  onChange: (features: string[]) => void;
}) {
  const { featureCatalogue } = useAppConfig();
  const { notify } = useToast();
  /* Keyed by feature rather than a single boolean: an admin switching two things
   * on in quick succession should not have the second switch look dead because
   * the first is still in flight. */
  const [busy, setBusy] = useState<string | null>(null);

  if (featureCatalogue.length === 0) return null;

  const on = new Set(user.features ?? []);

  async function set(key: string, enabled: boolean) {
    setBusy(key);
    try {
      const updated = await api.setUserFeature(user.id, key, enabled);
      // The account as the server now describes it, rather than this screen's
      // guess at the new set — the two cannot then drift.
      onChange(updated.features);
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Disclosure
      summary={`Features · ${on.size} of ${featureCatalogue.length} on`}
    >
      <div className="grid gap-2.5">
        {featureCatalogue.map((f) => (
          <Toggle
            key={f.key}
            checked={on.has(f.key)}
            disabled={busy !== null}
            onChange={(next) => void set(f.key, next)}
            label={f.label}
            description={f.description}
          />
        ))}
      </div>
    </Disclosure>
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

function AdminWebinars() {
  const { notify } = useToast();
  const [rows, setRows] = useState<Webinar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<(typeof STATUSES)[number]["value"]>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
                onClick={() => setStatus(s.value)}
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
          <label className="text-[12px] text-ink-3">
            From
            <input
              type="date"
              className="field mt-0.5 block"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="text-[12px] text-ink-3">
            To
            <input
              type="date"
              className="field mt-0.5 block"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>

        <input
          className="field mb-3 w-full max-w-sm"
          placeholder="Search by topic…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
            {rows.map((w) => (
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

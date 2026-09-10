"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { AdminUser } from "@/lib/api-types";
import { useSession, useToast } from "./providers";
import { Alert, Spinner, Toggle } from "./controls";
import { Avatar, Badge, Card, Empty, SectionTitle } from "./ui";

/* The admin panel: who may host.
 *
 * One privilege, so one screen. It exists because hosting used to be self-service — a checkbox
 * on the signup form and a toggle on the profile page — which meant anybody who found the URL
 * could create webinars and start collecting strangers' names, emails and phone numbers.
 *
 * There is no control here for making somebody an admin, and that is the design rather than a
 * missing feature. A privilege that can be granted through the UI can be granted by whoever
 * takes over one admin account, and then the boundary has bought nothing. Admins come from
 * ADMIN_EMAILS on the server, which needs access to the machine to change.
 */

export function AdminScreen() {
  const { account } = useSession();
  const { notify } = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">
                        {u.name}
                      </span>
                      {u.isAdmin && <Badge tone="brand">Admin</Badge>}
                      {isSelf && <Badge>You</Badge>}
                    </div>
                    <div className="truncate text-[12px] text-ink-3">
                      {u.email}
                      {u.webinarCount > 0 &&
                        ` · ${u.webinarCount} webinar${u.webinarCount === 1 ? "" : "s"}`}
                    </div>
                  </div>

                  {busy === u.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Toggle
                      checked={u.canHost}
                      /* Self-revoke is refused by the server too — this only saves the
                       * round trip. It is the one lockout with no way back from inside
                       * the app: the toggle you would use to restore it is this one. */
                      disabled={isSelf && u.canHost}
                      onChange={(next) => void setHost(u, next)}
                      label="Can host"
                    />
                  )}
                </div>
              );
            })}
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
    </div>
  );
}

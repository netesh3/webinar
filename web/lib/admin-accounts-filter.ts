import type { AdminUser } from "./api-types";

/* The Accounts tab's search and its Hosts / Attendees chips.
 *
 * Pure so the counts and the filter can be checked without a browser: the chip
 * counts follow the search text (so "Hosts 3" means three hosts match what you
 * typed), while the chip itself narrows the list underneath.
 *
 * "Attendee" here means an account that cannot host. Every account can attend;
 * the split an admin cares about is who has been granted hosting and who has not.
 */

export const ACCOUNT_ROLE_FILTERS = ["all", "hosts", "attendees"] as const;
export type AccountRoleFilter = (typeof ACCOUNT_ROLE_FILTERS)[number];

export const ACCOUNT_ROLE_LABEL: Record<AccountRoleFilter, string> = {
  all: "All",
  hosts: "Hosts",
  attendees: "Attendees",
};

type Account = Pick<AdminUser, "name" | "email" | "canHost">;

export function matchAccountQuery(u: Pick<AdminUser, "name" | "email">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (u.email ?? "").toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q);
}

export function matchAccountRole(u: Pick<AdminUser, "canHost">, role: AccountRoleFilter): boolean {
  if (role === "hosts") return u.canHost;
  if (role === "attendees") return !u.canHost;
  return true;
}

/** How many accounts each chip would show for the current search. */
export function countAccountRoles(
  users: readonly Account[],
  query: string,
): Record<AccountRoleFilter, number> {
  const counts = { all: 0, hosts: 0, attendees: 0 };
  for (const u of users) {
    if (!matchAccountQuery(u, query)) continue;
    counts.all++;
    if (u.canHost) counts.hosts++;
    else counts.attendees++;
  }
  return counts;
}

/** `pinned` keeps rows the admin just changed in view even if they no longer
 *  fit the chip — flipping "Can host" off under the Hosts chip must not make
 *  the row vanish from under the cursor. Search still applies to them. */
export function filterAccounts<T extends Account & { id: string }>(
  users: readonly T[],
  query: string,
  role: AccountRoleFilter,
  pinned: ReadonlySet<string> = new Set(),
): T[] {
  return users.filter(
    (u) => (pinned.has(u.id) || matchAccountRole(u, role)) && matchAccountQuery(u, query),
  );
}

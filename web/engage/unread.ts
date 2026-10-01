/* How the chat badge moves when a host opens a thread.
 *
 * The server is the record. This is the optimistic step so the number drops
 * before the next poll, and stays dropped if the same thread is opened twice
 * before that poll comes back. `seen` is the threads already taken off the
 * badge in this round; the poll clears it when it applies a fresh count.
 */

export type UnreadReply = {
  contactId: string;
  webinarId?: string;
};

export type UnreadSnap = {
  unread: number;
  recent: UnreadReply[];
  byWebinar: Record<string, number>;
};

export function applyThreadRead<T extends UnreadSnap>(
  snap: T,
  contactId: string,
  seen: Set<string>,
): T {
  if (seen.has(contactId)) return snap;
  seen.add(contactId);
  const hit = snap.recent.find((r) => r.contactId === contactId);
  const recent = snap.recent.filter((r) => r.contactId !== contactId);
  const byWebinar = { ...snap.byWebinar };
  const webinarId = hit?.webinarId;
  if (webinarId && byWebinar[webinarId]) {
    const left = byWebinar[webinarId] - 1;
    if (left > 0) byWebinar[webinarId] = left;
    else delete byWebinar[webinarId];
  }
  return {
    ...snap,
    unread: Math.max(0, snap.unread - 1),
    recent,
    byWebinar,
  };
}

/** One notification leaving the bell. Already-read rows do not move the number. */
export function applyAlertRead(unread: number, wasUnread: boolean): number {
  return wasUnread ? Math.max(0, unread - 1) : unread;
}

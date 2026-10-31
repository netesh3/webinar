/* How other tabs and the extra room window hear that the host list changed.
 *
 * The list cache is in-memory per window. Create / start / end in one window
 * must drop the others, or Upcoming keeps showing a session that already ended
 * until the host navigates away and back. sessionStorage would not cross
 * windows; the storage event is how the rest of the app already shares a
 * choice (sign-out, theme) without a second channel. postMessage covers the
 * Electron extra room window, whose opener often stays "visible" the whole
 * time so visibilitychange never fires. */

/** Other tabs hear a drop through this key. */
export const HOST_LIST_DROP_KEY = "webcast.host-lists.drop";

/** postMessage type the extra room window sends to window.opener. */
export const HOST_LIST_DROP_MESSAGE = "webcast.host-lists.drop";

export function publishHostListDrop(storage?: Pick<Storage, "setItem">): void {
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!target) return;
  try {
    target.setItem(HOST_LIST_DROP_KEY, String(Date.now()));
  } catch {
    // Private mode can refuse storage. This tab already dropped.
  }
}

/** A storage event from another tab that dropped the host list. Removing the
 *  key, or any other key, is not a drop. */
export function isHostListDropNotice(event: {
  key: string | null;
  newValue: string | null;
}): boolean {
  return event.key === HOST_LIST_DROP_KEY && event.newValue != null && event.newValue !== "";
}

export function isHostListDropMessage(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === HOST_LIST_DROP_MESSAGE
  );
}
